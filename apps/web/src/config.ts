import type { AuthConfig } from "./auth.js";

/**
 * Runtime configuration.
 *
 * Supplied at build time by Vite's `VITE_*` environment variables, which the
 * deploy pipeline fills from CloudFormation stack outputs. None of it is
 * secret: a Cognito domain, a public client id, and the origin the app is
 * served from. A browser app has no secrets, which is exactly why the client
 * uses PKCE rather than a client secret.
 */

const required = (name: string, value: string | undefined): string => {
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env.local and fill it in, or ` +
        `let the deploy pipeline inject it from stack outputs.`,
    );
  }
  return value;
};

export const cognito: AuthConfig = {
  domain: required("VITE_COGNITO_DOMAIN", import.meta.env.VITE_COGNITO_DOMAIN),
  clientId: required("VITE_COGNITO_CLIENT_ID", import.meta.env.VITE_COGNITO_CLIENT_ID),

  // Must appear verbatim in the app client's callback list, so it is derived
  // from the actual origin rather than configured separately and allowed to
  // drift.
  redirectUri: `${window.location.origin}/callback`,
  scopes: ["openid", "email", "profile"],
};

/** The only keyboard the catalog currently describes. */
export const DEFAULT_KEYBOARD = "apex-pro-gen-3";

export interface Backend {
  readonly id: "dotnet" | "serverless";
  readonly label: string;
  readonly detail: string;
  /** Empty means same-origin. */
  readonly baseUrl: string;
}

/**
 * The two implementations, switchable at runtime.
 *
 * This is the repository's whole argument made clickable: the same requests,
 * the same screen, two completely different backends. If they ever disagree
 * it shows up here immediately rather than in a test nobody ran.
 *
 * The .NET API is same-origin because CloudFront fronts both it and this app.
 * The serverless one is a separate API Gateway domain, so those calls really
 * are cross-origin — which is why only that stack configures CORS.
 */
export const BACKENDS: readonly Backend[] = [
  {
    id: "dotnet",
    label: ".NET",
    detail: "ASP.NET Core · SQLite on EFS · ECS Fargate",
    baseUrl: "",
  },
  {
    id: "serverless",
    label: "Serverless",
    detail: "TypeScript · DynamoDB · Lambda",
    baseUrl: import.meta.env.VITE_SERVERLESS_API_URL ?? "",
  },
];

const STORAGE_KEY = "apex.backend";

export function loadBackend(): Backend {
  const saved = localStorage.getItem(STORAGE_KEY);
  return BACKENDS.find((backend) => backend.id === saved) ?? BACKENDS[0]!;
}

export function rememberBackend(backend: Backend): void {
  localStorage.setItem(STORAGE_KEY, backend.id);
}
