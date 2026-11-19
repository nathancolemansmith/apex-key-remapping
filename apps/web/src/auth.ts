/**
 * Cognito hosted UI login, using the authorization code flow with PKCE.
 *
 * Written by hand rather than pulled from an OIDC library. The flow is about
 * a hundred lines of Web Crypto, and for a single provider with one client
 * that is easier to audit than a dependency whose configuration surface is
 * larger than the thing it configures. A multi-provider app should use a
 * library.
 *
 * PKCE exists because this client has no secret — it runs in a browser, where
 * nothing is secret. Instead the app invents a random `code_verifier`, sends
 * only its SHA-256 hash to start the flow, and reveals the original when
 * redeeming the code. An attacker who intercepts the redirect gets a code
 * they cannot exchange, because they never saw the verifier.
 */

export interface AuthConfig {
  readonly domain: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
}

export interface Session {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly refreshToken?: string;
}

const STORAGE_KEY = "apex.session";
const VERIFIER_KEY = "apex.pkce.verifier";
const STATE_KEY = "apex.pkce.state";

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...view))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function randomString(byteLength = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(digest);
}

/** Sends the browser to Cognito. Nothing after this runs — it navigates away. */
export async function login(config: AuthConfig): Promise<void> {
  const verifier = randomString();
  const state = randomString(16);

  // Session storage, not local: these are single-use and scoped to this tab.
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes.join(" "),
    state,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "S256",
  });

  window.location.assign(`${config.domain}/oauth2/authorize?${params}`);
}

/**
 * Handles the redirect back from Cognito. Returns null when this is an
 * ordinary page load rather than a callback.
 */
export async function completeLogin(config: AuthConfig): Promise<Session | null> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    clearPkce();
    throw new Error(url.searchParams.get("error_description") ?? error);
  }
  if (!code) return null;

  const expectedState = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  clearPkce();

  // The state check is what stops a third party from feeding us a code they
  // obtained elsewhere — a login CSRF.
  if (!expectedState || returnedState !== expectedState) {
    throw new Error("Authorization state did not match. Start the login again.");
  }
  if (!verifier) {
    throw new Error("Missing PKCE verifier. Start the login again.");
  }

  const response = await fetch(`${config.domain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed (${response.status}): ${await response.text()}`);
  }

  const payload = (await response.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };

  const session = persist({
    accessToken: payload.access_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
    ...(payload.refresh_token ? { refreshToken: payload.refresh_token } : {}),
  });

  // Strip the code from the address bar so a refresh does not try to redeem
  // it twice — authorization codes are single-use.
  window.history.replaceState({}, "", url.pathname);

  return session;
}

/** Trades a refresh token for a new access token. Returns null if it cannot. */
export async function refresh(config: AuthConfig, session: Session): Promise<Session | null> {
  if (!session.refreshToken) return null;

  const response = await fetch(`${config.domain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.clientId,
      refresh_token: session.refreshToken,
    }),
  });

  if (!response.ok) return null;

  const payload = (await response.json()) as { access_token: string; expires_in: number };

  return persist({
    accessToken: payload.access_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
    refreshToken: session.refreshToken,
  });
}

export function loadSession(): Session | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const session = JSON.parse(raw) as Session;
    // A minute of slack, so a request is not sent with a token that expires
    // while it is in flight.
    return session.expiresAt > Date.now() + 60_000 ? session : null;
  } catch {
    return null;
  }
}

export function logout(config: AuthConfig): void {
  localStorage.removeItem(STORAGE_KEY);
  clearPkce();

  const params = new URLSearchParams({
    client_id: config.clientId,
    logout_uri: new URL(config.redirectUri).origin,
  });
  window.location.assign(`${config.domain}/logout?${params}`);
}

/** Decodes the token payload for display. Never for trust — the API validates. */
export function describeToken(accessToken: string): Record<string, unknown> | null {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return null;
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function persist(session: Session): Session {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  return session;
}

function clearPkce(): void {
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
}
