import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

/**
 * Configuration the client cannot run without.
 *
 * Vite inlines `VITE_*` at build time, so a missing variable is not an
 * environment problem at runtime — it is a bundle with the literal
 * `undefined` compiled into it. Checked here rather than only in config.ts so
 * a misconfigured build fails in CI instead of shipping and dying in
 * someone's browser.
 */
const REQUIRED = ["VITE_COGNITO_DOMAIN", "VITE_COGNITO_CLIENT_ID"] as const;

export default defineConfig(({ command, mode }) => {
  // Vite has not populated import.meta.env yet at config time; loadEnv reads
  // the same .env files it would, plus anything already in process.env (which
  // is how the deploy workflow supplies them).
  const env = { ...loadEnv(mode, process.cwd(), "VITE_"), ...process.env };
  const missing = REQUIRED.filter((name) => !env[name]);

  if (missing.length > 0) {
    const detail =
      `Missing ${missing.join(", ")}.\n` +
      `  Local:  cp .env.example .env.local  (values are stack outputs, none are secret)\n` +
      `  CI:     the deploy workflow reads them from the ApexIdentity stack`;

    // Building without them produces a broken artifact, so refuse. Serving
    // without them is merely a login that fails, which is worth a warning but
    // not a wall — someone may be working on the UI offline.
    if (command === "build") throw new Error(`Cannot build the web client.\n${detail}`);
    console.warn(`\n⚠  Sign-in will not work.\n${detail}\n`);
  }

  const apiProxy = env.VITE_API_PROXY ?? "http://localhost:5080";

  return {
    plugins: [react()],
    server: {
      // Cognito's callback list names this port explicitly, and an unexpected
      // port is rejected at the redirect rather than failing somewhere obvious.
      port: 5173,
      strictPort: true,

      // In development the client and API are separate origins, which would
      // mean CORS. Proxying keeps requests same-origin locally, matching how
      // CloudFront serves them in AWS — so the app never knows the difference.
      proxy: {
        "/api": { target: apiProxy, changeOrigin: true },
        "/health": { target: apiProxy, changeOrigin: true },
      },
    },
    build: { outDir: "dist", sourcemap: true },
  };
});
