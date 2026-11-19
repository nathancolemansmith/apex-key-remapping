import {
  buildMappingsResponse,
  findKeyboard,
  keyboards,
  mergeMappings,
  parseHidCode,
  validateMappings,
  type KeyMapping,
} from "@apex/hid-catalog";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { LayoutRepository } from "./repository.js";
import {
  malformedBody,
  noContent,
  notFound,
  ok,
  unauthorized,
  unknownKeyboard,
  validationFailed,
} from "./responses.js";

/**
 * The same seven operations as the .NET API, over DynamoDB.
 *
 * The interesting part is what is *not* here. There is no validation logic,
 * no HID parsing, no response projection — all of it is imported from
 * `@apex/hid-catalog`, the same module the .NET side had to reimplement in
 * C#. Two consumers share an implementation; the third shares a
 * specification. This is the cheap one.
 *
 * **Authentication happens before this runs.** An API Gateway JWT authorizer
 * verifies the token against the Cognito pool, so unauthenticated traffic
 * never reaches application code or costs an invocation. The handler reads a
 * `sub` that has already been checked — which is why there is no signature
 * validation here and no JWKS to fetch.
 *
 * **The catalog is bundled, not stored.** The .NET side seeds 92 rows into
 * SQLite because the schema then enforces that a remap targets a real key.
 * DynamoDB has no foreign keys to enforce anything with, so putting the
 * catalog in the table would add a read per request and buy nothing. It is
 * product data, identical for every user, and it ships in the bundle.
 */

const repository = new LayoutRepository(requireEnv("TABLE_NAME"));

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  // Pre-verified by the authorizer. Absent only if the route was somehow
  // configured without one, which would be a deployment error — fail closed.
  const ownerSub = event.requestContext.authorizer?.jwt?.claims?.sub;
  const method = event.requestContext.http.method.toUpperCase();
  const path = event.requestContext.http.path;

  if (path === "/health") {
    return ok({ status: "healthy" });
  }

  if (typeof ownerSub !== "string" || ownerSub.length === 0) {
    return unauthorized();
  }

  if (path === "/api/keyboards" && method === "GET") {
    return listKeyboards(ownerSub);
  }

  const match = /^\/api\/keyboards\/([^/]+)\/mappings(?:\/([^/]+))?$/.exec(path);
  if (!match) return notFound();

  const identifier = decodeURIComponent(match[1]!);
  const hidCodeSegment = match[2] ? decodeURIComponent(match[2]) : undefined;

  const keyboard = findKeyboard(identifier);
  if (!keyboard) return unknownKeyboard(identifier);

  switch (method) {
    case "GET":
      return readLayout(ownerSub, keyboard.slug);

    case "POST":
      return write(ownerSub, keyboard, event.body, { replace: false });

    case "PUT":
      return write(ownerSub, keyboard, event.body, { replace: true });

    case "DELETE":
      return hidCodeSegment === undefined
        ? clearAll(ownerSub, keyboard.slug)
        : clearOne(ownerSub, keyboard, hidCodeSegment);

    default:
      return notFound();
  }
}

async function listKeyboards(ownerSub: string): Promise<APIGatewayProxyStructuredResultV2> {
  const summaries = await Promise.all(
    keyboards.map(async (keyboard) => ({
      slug: keyboard.slug,
      name: keyboard.name,
      vendor: keyboard.vendor,
      totalKeys: keyboard.keys.length,
      owned: await repository.owns(ownerSub, keyboard.slug),
    })),
  );

  return ok({ keyboards: summaries });
}

async function readLayout(
  ownerSub: string,
  slug: string,
): Promise<APIGatewayProxyStructuredResultV2> {
  const keyboard = findKeyboard(slug)!;
  const stored = await repository.get(ownerSub, slug);
  return ok(buildMappingsResponse(keyboard, stored.mappings));
}

async function write(
  ownerSub: string,
  keyboard: ReturnType<typeof findKeyboard> & object,
  rawBody: string | undefined,
  { replace }: { replace: boolean },
): Promise<APIGatewayProxyStructuredResultV2> {
  let body: unknown;
  try {
    body = rawBody ? JSON.parse(rawBody) : undefined;
  } catch {
    return malformedBody("`mappings` must be an array.");
  }

  if (typeof body !== "object" || body === null || !("mappings" in body)) {
    return malformedBody("`mappings` must be an array.");
  }

  const result = validateMappings(keyboard, (body as { mappings: unknown }).mappings);
  if (!result.ok) return validationFailed(result.errors);

  // PUT is declarative: the request is the whole layout. POST merges over
  // what is stored, and `cleared` carries the keys mapped to themselves —
  // without it, a request asking to clear a binding silently leaves it.
  let desired: readonly KeyMapping[];
  if (replace) {
    desired = result.mappings;
  } else {
    const stored = await repository.get(ownerSub, keyboard.slug);
    desired = mergeMappings(stored.mappings, result.mappings, result.cleared);
  }

  await repository.save(ownerSub, keyboard.slug, desired, new Date());
  return noContent();
}

async function clearOne(
  ownerSub: string,
  keyboard: ReturnType<typeof findKeyboard> & object,
  rawHidCode: string,
): Promise<APIGatewayProxyStructuredResultV2> {
  const parsed = parseHidCode(rawHidCode);

  // A code that is not a key on this keyboard is a malformed request rather
  // than a missing resource, so 400 and not 404 — matching the .NET side.
  if (parsed === null) {
    return validationFailed([
      {
        index: -1,
        field: "from",
        message: `"${rawHidCode}" is not a valid 8-bit HID code (expected 0–255 or 0x00–0xFF).`,
      },
    ]);
  }
  if (!keyboard.keys.some((key) => key.hidCode === parsed)) {
    return validationFailed([
      {
        index: -1,
        field: "from",
        message: `0x${parsed.toString(16).toUpperCase().padStart(2, "0")} is not a key on ${keyboard.name}.`,
      },
    ]);
  }

  const stored = await repository.get(ownerSub, keyboard.slug);
  const remaining = stored.mappings.filter((mapping) => mapping.from !== parsed);

  // Idempotent: clearing a key that was never remapped is still a success,
  // so a client retrying after a dropped response sees no spurious error.
  if (remaining.length !== stored.mappings.length) {
    await repository.save(ownerSub, keyboard.slug, remaining, new Date());
  }

  return noContent();
}

async function clearAll(
  ownerSub: string,
  slug: string,
): Promise<APIGatewayProxyStructuredResultV2> {
  await repository.clear(ownerSub, slug);
  return noContent();
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. The CDK stack supplies it.`);
  return value;
}
