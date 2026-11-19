import type { KeyboardMappingsResponse, KeyMapping } from "@apex/hid-catalog";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiClient, ApiError } from "./api.js";
import { completeLogin, describeToken, loadSession, login, logout, type Session } from "./auth.js";
import { KeyboardGrid } from "./components/KeyboardGrid.js";
import { RemapPanel } from "./components/RemapPanel.js";
import { cognito, DEFAULT_KEYBOARD } from "./config.js";

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [layout, setLayout] = useState<KeyboardMappingsResponse | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Edits the user has made but not saved, as from → to. Kept separate from
   * the server's layout so the UI can show all three states honestly: what is
   * stored, what is changed, and what is merely selected. Saving replaces the
   * whole set via PUT, which is what makes a Save button idempotent.
   */
  const [pending, setPending] = useState<Map<number, number>>(new Map());

  const api = useMemo(() => (session ? new ApiClient(session.accessToken) : null), [session]);

  // Handle the redirect back from Cognito before anything else renders.
  useEffect(() => {
    completeLogin(cognito)
      .then((next) => next && setSession(next))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  const reload = useCallback(async () => {
    if (!api) return;
    setBusy(true);
    try {
      setLayout(await api.getMappings(DEFAULT_KEYBOARD));
      setPending(new Map());
      setError(null);
    } catch (cause) {
      if (cause instanceof ApiError && cause.isUnauthorized) {
        // The token expired or was rejected. Drop it rather than leaving the
        // UI in a state where every action fails.
        localStorage.removeItem("apex.session");
        setSession(null);
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const stage = (from: number, to: number) => {
    setPending((previous) => {
      const next = new Map(previous);
      const stored = layout?.keys.find((k) => k.hidCode === from)?.mappedTo.hidCode ?? from;
      // Staging the value that is already saved is not an edit.
      if (to === stored) next.delete(from);
      else next.set(from, to);
      return next;
    });
  };

  const save = async () => {
    if (!api || !layout) return;
    setBusy(true);
    try {
      // Build the complete set: stored remaps with pending edits applied.
      const effective = new Map<number, number>();
      for (const key of layout.keys) {
        if (key.isRemapped) effective.set(key.hidCode, key.mappedTo.hidCode);
      }
      for (const [from, to] of pending) {
        if (from === to) effective.delete(from);
        else effective.set(from, to);
      }

      const mappings: KeyMapping[] = [...effective]
        .map(([from, to]) => ({ from, to }))
        .sort((a, b) => a.from - b.from);

      await api.replaceMappings(DEFAULT_KEYBOARD, mappings);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  const clearAll = async () => {
    if (!api) return;
    setBusy(true);
    try {
      await api.clearAll(DEFAULT_KEYBOARD);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  if (!session) return <SignIn error={error} />;

  const claims = describeToken(session.accessToken);
  const selectedKey = layout?.keys.find((k) => k.hidCode === selected) ?? null;
  const remappedCount =
    layout === null
      ? 0
      : [...pending].reduce(
          (count, [from, to]) => {
            const wasRemapped = layout.keys.find((k) => k.hidCode === from)?.isRemapped ?? false;
            const willBeRemapped = to !== from;
            return count + (willBeRemapped ? 1 : 0) - (wasRemapped ? 1 : 0);
          },
          layout.remappedCount,
        );

  return (
    <div className="container-fluid py-4" style={{ maxWidth: "1400px" }}>
      <header className="d-flex flex-wrap justify-content-between align-items-center gap-3 mb-4">
        <div>
          <h1 className="h4 mb-0">{layout?.keyboard ?? "Apex Pro Gen 3"}</h1>
          <div className="small text-body-secondary">
            {layout ? `${layout.totalKeys} keys · ${remappedCount} remapped` : "Loading…"}
            {pending.size > 0 && (
              <span className="text-warning ms-2">· {pending.size} unsaved</span>
            )}
          </div>
        </div>

        <div className="d-flex align-items-center gap-2">
          <span className="small text-body-secondary font-monospace d-none d-md-inline">
            {typeof claims?.username === "string" ? claims.username : "signed in"}
          </span>
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            onClick={() => logout(cognito)}
          >
            Sign out
          </button>
        </div>
      </header>

      {error && (
        <div className="alert alert-danger d-flex justify-content-between align-items-start">
          <span className="small">{error}</span>
          <button type="button" className="btn-close" onClick={() => setError(null)} />
        </div>
      )}

      <div className="row g-4">
        <div className="col-lg-8">
          {layout ? (
            <KeyboardGrid
              keys={layout.keys}
              selected={selected}
              pending={pending}
              onSelect={(hidCode) => setSelected(hidCode === selected ? null : hidCode)}
            />
          ) : (
            <div className="text-body-secondary">Loading the layout…</div>
          )}
        </div>

        <div className="col-lg-4">
          <div className="position-sticky" style={{ top: "1rem" }}>
            <RemapPanel
              keys={layout?.keys ?? []}
              selected={selectedKey}
              pendingTarget={pending.get(selected ?? -1)}
              onChange={stage}
              onClear={(from) => stage(from, from)}
              onDismiss={() => setSelected(null)}
            />

            <div className="d-grid gap-2 mt-3">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || pending.size === 0}
                onClick={() => void save()}
              >
                {busy ? "Saving…" : `Save ${pending.size || ""} change${pending.size === 1 ? "" : "s"}`}
              </button>
              <button
                type="button"
                className="btn btn-outline-secondary btn-sm"
                disabled={busy || pending.size === 0}
                onClick={() => setPending(new Map())}
              >
                Discard changes
              </button>
              <button
                type="button"
                className="btn btn-outline-danger btn-sm"
                disabled={busy || remappedCount === 0}
                onClick={() => void clearAll()}
              >
                Clear every remap
              </button>
            </div>

            <p className="small text-body-secondary mt-3 mb-0">
              Saving sends the complete layout, so the same request applied
              twice leaves the same state.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function SignIn({ error }: { error: string | null }) {
  return (
    <div className="container d-flex align-items-center justify-content-center min-vh-100">
      <div className="text-center" style={{ maxWidth: "26rem" }}>
        <h1 className="h3">Apex Key Remapping</h1>
        <p className="text-body-secondary">
          Remap the keys on a SteelSeries Apex Pro Gen 3. Layouts are private to
          your account.
        </p>

        {error && <div className="alert alert-danger small text-start">{error}</div>}

        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void login(cognito)}
        >
          Sign in with Cognito
        </button>
      </div>
    </div>
  );
}
