import type { KeyboardMappingsResponse, KeyMapping } from "@apex/hid-catalog";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiClient, ApiError } from "./api.js";
import { completeLogin, describeToken, loadSession, login, logout, type Session } from "./auth.js";
import { Keyboard } from "./components/Keyboard.js";
import { RemapPanel } from "./components/RemapPanel.js";
import {
  BACKENDS,
  cognito,
  DEFAULT_KEYBOARD,
  loadBackend,
  rememberBackend,
  type Backend,
} from "./config.js";

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [backend, setBackend] = useState<Backend>(() => loadBackend());
  const [layout, setLayout] = useState<KeyboardMappingsResponse | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [flat, setFlat] = useState(false);

  /**
   * Edits made but not saved, as from → to. Kept apart from the server's
   * layout so the board can show all three states at once: what is stored,
   * what has changed, and what is merely selected.
   */
  const [pending, setPending] = useState<Map<number, number>>(new Map());

  const api = useMemo(
    () => (session ? new ApiClient(session.accessToken, backend.baseUrl) : null),
    [session, backend],
  );

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

  const switchBackend = (next: Backend) => {
    // Unsaved edits belong to the backend they were made against; carrying
    // them across would write one store's state into the other's.
    setPending(new Map());
    setSelected(null);
    setBackend(next);
    rememberBackend(next);
  };

  const stage = (from: number, to: number) => {
    setPending((previous) => {
      const next = new Map(previous);
      const stored = layout?.keys.find((k) => k.hidCode === from)?.mappedTo.hidCode ?? from;
      if (to === stored) next.delete(from);
      else next.set(from, to);
      return next;
    });
  };

  const save = async () => {
    if (!api || !layout) return;
    setBusy(true);
    try {
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
  const savedCount = layout?.remappedCount ?? 0;

  return (
    <div className="min-vh-100 d-flex flex-column">
      <header className="border-bottom border-secondary-subtle px-4 py-3 d-flex flex-wrap align-items-center gap-3">
        <div className="me-auto">
          <h1 className="h5 mb-0">{layout?.keyboard ?? "Apex Pro Gen 3"}</h1>
          <div className="small text-body-secondary">
            {layout ? `${layout.totalKeys} keys · ${savedCount} remapped` : "Loading…"}
            {pending.size > 0 && <span className="text-warning"> · {pending.size} unsaved</span>}
          </div>
        </div>

        <BackendToggle current={backend} busy={busy} onChange={switchBackend} />

        <div className="d-flex align-items-center gap-2">
          <div className="form-check form-switch mb-0">
            <input
              className="form-check-input"
              type="checkbox"
              id="flat"
              checked={flat}
              onChange={(event) => setFlat(event.target.checked)}
            />
            <label className="form-check-label small text-body-secondary" htmlFor="flat">
              Flat
            </label>
          </div>
          <span className="small text-body-secondary font-monospace d-none d-lg-inline">
            {typeof claims?.username === "string" ? claims.username : "signed in"}
          </span>
          <button className="btn btn-sm btn-outline-secondary" onClick={() => logout(cognito)}>
            Sign out
          </button>
        </div>
      </header>

      {error && (
        <div className="alert alert-danger rounded-0 mb-0 d-flex justify-content-between align-items-start">
          <span className="small">{error}</span>
          <button type="button" className="btn-close" onClick={() => setError(null)} />
        </div>
      )}

      <main className="flex-grow-1 d-flex flex-column flex-xl-row gap-4 p-4">
        {/* min-width: 0 is load-bearing. A flex item defaults to min-width:
            auto, so it refuses to shrink below its content and the keyboard
            pushes the sidebar off-screen instead of scaling down. */}
        <div className="flex-grow-1" style={{ minWidth: 0 }}>
          {layout ? (
            <>
              <Keyboard
                keys={layout.keys}
                selected={selected}
                pending={pending}
                flat={flat}
                onSelect={(hidCode) => setSelected(hidCode === selected ? null : hidCode)}
              />
              <Legend />
            </>
          ) : (
            <div className="text-body-secondary p-5 text-center">Loading the layout…</div>
          )}
        </div>

        <aside style={{ width: "min(100%, 22rem)", flex: "0 0 auto" }}>
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
                className="btn btn-primary"
                disabled={busy || pending.size === 0}
                onClick={() => void save()}
              >
                {busy ? "Saving…" : pending.size ? `Save ${pending.size} change${pending.size === 1 ? "" : "s"}` : "Save"}
              </button>
              <button
                className="btn btn-outline-secondary btn-sm"
                disabled={busy || pending.size === 0}
                onClick={() => setPending(new Map())}
              >
                Discard changes
              </button>
              <button
                className="btn btn-outline-danger btn-sm"
                disabled={busy || savedCount === 0}
                onClick={() => void clearAll()}
              >
                Clear every remap
              </button>
            </div>

            <p className="small text-body-secondary mt-3 mb-0">
              Saving sends the complete layout, so the same request applied twice
              leaves the same state.
            </p>
          </div>
        </aside>
      </main>
    </div>
  );
}

/**
 * Switches which implementation the page is talking to.
 *
 * Both answer the same contract, so nothing else in the app changes — the
 * layout, the editor and the save button are identical either way. That is
 * the point: if the two ever diverge, flipping this reveals it.
 */
function BackendToggle({
  current,
  busy,
  onChange,
}: {
  current: Backend;
  busy: boolean;
  onChange: (backend: Backend) => void;
}) {
  return (
    <div className="d-flex flex-column align-items-center">
      <div className="btn-group btn-group-sm" role="group" aria-label="Backend implementation">
        {BACKENDS.map((backend) => {
          const unavailable = backend.id === "serverless" && !backend.baseUrl;
          return (
            <button
              key={backend.id}
              type="button"
              className={`btn ${current.id === backend.id ? "btn-primary" : "btn-outline-secondary"}`}
              disabled={busy || unavailable}
              onClick={() => onChange(backend)}
              title={unavailable ? "VITE_SERVERLESS_API_URL is not configured" : backend.detail}
              aria-pressed={current.id === backend.id}
            >
              {backend.label}
            </button>
          );
        })}
      </div>
      <span className="text-body-secondary mt-1" style={{ fontSize: "0.68rem" }}>
        {current.detail}
      </span>
    </div>
  );
}

function Legend() {
  const items = [
    { color: "linear-gradient(180deg,#32363d,#1c1f24)", label: "Not remapped" },
    { color: "linear-gradient(180deg,#4a3328,#2a1d16)", label: "Remapped" },
    { color: "linear-gradient(180deg,#4c4122,#2b2512)", label: "Unsaved" },
    { color: "linear-gradient(180deg,#212429,#15171a)", label: "Not in the catalog" },
  ];

  return (
    <div className="d-flex flex-wrap justify-content-center gap-4 mt-3 small text-body-secondary">
      {items.map((item) => (
        <span key={item.label} className="d-inline-flex align-items-center gap-2">
          <span className="kb-key-swatch" style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

function SignIn({ error }: { error: string | null }) {
  return (
    <div className="container d-flex align-items-center justify-content-center min-vh-100">
      <div className="text-center" style={{ maxWidth: "28rem" }}>
        <h1 className="h3">Apex Key Remapping</h1>
        <p className="text-body-secondary">
          Remap the keys on a SteelSeries Apex Pro Gen 3. Layouts are private to
          your account, and the same layout is served by either backend.
        </p>

        {error && <div className="alert alert-danger small text-start">{error}</div>}

        <button className="btn btn-primary" onClick={() => void login(cognito)}>
          Sign in with Cognito
        </button>
      </div>
    </div>
  );
}
