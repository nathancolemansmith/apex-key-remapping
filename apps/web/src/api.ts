import type {
  KeyboardMappingsResponse,
  KeyMapping,
  ProblemDetails,
} from "@apex/hid-catalog";

/**
 * The API, typed from the shared domain package.
 *
 * These are the same interfaces the serverless implementation will build its
 * responses from, so a contract change that this client has not accounted for
 * is a compile error rather than a runtime surprise.
 *
 * Every request is same-origin: Vite proxies `/api` in development, and
 * CloudFront routes it to the ALB in AWS. That is deliberate — it means no
 * CORS configuration exists to get wrong, and the browser never sees a second
 * origin.
 */

export interface KeyboardSummary {
  readonly slug: string;
  readonly name: string;
  readonly vendor: string;
  readonly totalKeys: number;
  readonly owned: boolean;
}

/** A failure the UI can render, carrying the per-field detail when present. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly problem?: ProblemDetails,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** True when the token is missing, expired or rejected. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

export class ApiClient {
  constructor(private readonly accessToken: string) {}

  listKeyboards(): Promise<{ keyboards: KeyboardSummary[] }> {
    return this.send("/api/keyboards");
  }

  getMappings(keyboard: string): Promise<KeyboardMappingsResponse> {
    return this.send(`/api/keyboards/${encodeURIComponent(keyboard)}/mappings`);
  }

  /** PUT: the body becomes the whole layout. Anything absent is cleared. */
  async replaceMappings(keyboard: string, mappings: readonly KeyMapping[]): Promise<void> {
    await this.send(`/api/keyboards/${encodeURIComponent(keyboard)}/mappings`, {
      method: "PUT",
      body: JSON.stringify({ mappings }),
    });
  }

  /** POST: upserts the listed keys and leaves the rest alone. */
  async addMappings(keyboard: string, mappings: readonly KeyMapping[]): Promise<void> {
    await this.send(`/api/keyboards/${encodeURIComponent(keyboard)}/mappings`, {
      method: "POST",
      body: JSON.stringify({ mappings }),
    });
  }

  async clearMapping(keyboard: string, hidCode: number): Promise<void> {
    await this.send(`/api/keyboards/${encodeURIComponent(keyboard)}/mappings/${hidCode}`, {
      method: "DELETE",
    });
  }

  async clearAll(keyboard: string): Promise<void> {
    await this.send(`/api/keyboards/${encodeURIComponent(keyboard)}/mappings`, {
      method: "DELETE",
    });
  }

  private async send<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });

    if (response.status === 204) return undefined as T;

    if (!response.ok) {
      // The API answers failures as RFC 9457 problem details. Use them when
      // they are there and fall back to the status when they are not, so a
      // proxy error page does not crash the parser.
      let problem: ProblemDetails | undefined;
      try {
        problem = (await response.json()) as ProblemDetails;
      } catch {
        problem = undefined;
      }

      throw new ApiError(
        response.status,
        problem?.detail ?? problem?.title ?? `Request failed with ${response.status}`,
        problem,
      );
    }

    return (await response.json()) as T;
  }
}
