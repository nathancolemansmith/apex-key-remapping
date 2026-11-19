import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Drives the handler directly with API Gateway events, against an in-memory
 * stand-in for DynamoDB.
 *
 * These assert the *contract* — status codes, response shapes, error text —
 * rather than the implementation, because the same assertions have to hold
 * for the .NET API. Where a string is checked verbatim it is because the
 * contract promises both backends produce it.
 */

const TABLE = "test-layouts";
process.env.TABLE_NAME = TABLE;

/** A minimal DynamoDB document client: enough surface for the repository. */
const store = new Map<string, Record<string, unknown>>();
const keyOf = (key: Record<string, unknown>) => `${String(key.pk)}|${String(key.sk)}`;

vi.mock("@aws-sdk/lib-dynamodb", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/lib-dynamodb")>(
    "@aws-sdk/lib-dynamodb",
  );
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (command: { constructor: { name: string }; input: Record<string, never> }) => {
          const input = command.input as unknown as {
            Key?: Record<string, unknown>;
            Item?: Record<string, unknown>;
          };
          switch (command.constructor.name) {
            case "GetCommand":
              return { Item: store.get(keyOf(input.Key!)) };
            case "PutCommand":
              store.set(keyOf(input.Item!), input.Item!);
              return {};
            case "DeleteCommand":
              store.delete(keyOf(input.Key!));
              return {};
            default:
              throw new Error(`Unhandled command ${command.constructor.name}`);
          }
        },
      }),
    },
  };
});

const { handler } = await import("./handler.js");

const A = 0x04;
const Z = 0x1d;
const B = 0x05;
const C = 0x06;
const NOT_A_KEY = 0x64;

interface RequestOptions {
  readonly sub?: string | undefined;
  readonly body?: unknown;
}

function request(method: string, path: string, options: RequestOptions = {}) {
  // Checked by key presence rather than a destructuring default: `{ sub:
  // undefined }` would *trigger* a default, so the anonymous case would
  // silently authenticate as alice and the 401 test would pass for the wrong
  // reason — which is exactly what it did first time.
  const sub = "sub" in options ? options.sub : "alice";
  const { body } = options;

  return handler({
    version: "2.0",
    rawPath: path,
    requestContext: {
      http: { method, path },
      ...(sub ? { authorizer: { jwt: { claims: { sub } } } } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  } as never);
}

const mappings = (...pairs: [number, number][]) => ({
  mappings: pairs.map(([from, to]) => ({ from, to })),
});

const bodyOf = (response: { body?: string }) => JSON.parse(response.body ?? "{}");

beforeEach(() => store.clear());

describe("health", () => {
  it("is reachable without a token", async () => {
    const response = await request("GET", "/health", { sub: undefined });
    expect(response.statusCode).toBe(200);
    expect(bodyOf(response).status).toBe("healthy");
  });
});

describe("authentication", () => {
  it("rejects a request the authorizer did not attach a sub to", async () => {
    const response = await request("GET", "/api/keyboards", { sub: undefined });
    expect(response.statusCode).toBe(401);
    expect(response.headers?.["Content-Type"]).toBe("application/problem+json");
  });
});

describe("reading a layout", () => {
  it("returns every key, remapped or not", async () => {
    const response = await request("GET", "/api/keyboards/apex-pro-gen-3/mappings");
    const body = bodyOf(response);

    expect(response.statusCode).toBe(200);
    expect(body.keyboard).toBe("Apex Pro Gen 3");
    expect(body.totalKeys).toBe(92);
    expect(body.keys).toHaveLength(92);
    expect(body.remappedCount).toBe(0);
  });

  it("maps un-remapped keys to themselves", async () => {
    const body = bodyOf(await request("GET", "/api/keyboards/apex-pro-gen-3/mappings"));
    for (const key of body.keys) {
      expect(key.isRemapped).toBe(false);
      expect(key.mappedTo.hidCode).toBe(key.hidCode);
    }
  });

  it("returns keys in HID code order", async () => {
    const body = bodyOf(await request("GET", "/api/keyboards/apex-pro-gen-3/mappings"));
    const codes = body.keys.map((k: { hidCode: number }) => k.hidCode);
    expect(codes).toEqual([...codes].sort((a: number, b: number) => a - b));
  });

  it("resolves the keyboard by display name as well as slug", async () => {
    const response = await request("GET", "/api/keyboards/Apex%20Pro%20Gen%203/mappings");
    expect(response.statusCode).toBe(200);
    expect(bodyOf(response).keyboardSlug).toBe("apex-pro-gen-3");
  });

  it("404s an unknown keyboard", async () => {
    const response = await request("GET", "/api/keyboards/model-m/mappings");
    expect(response.statusCode).toBe(404);
    expect(bodyOf(response).detail).toBe("'model-m' is not a supported keyboard.");
  });
});

describe("writing", () => {
  it("accepts the brief's own example", async () => {
    const write = await request("POST", "/api/keyboards/apex-pro-gen-3/mappings", {
      body: mappings([A, Z], [0x21, 0x1f]),
    });
    expect(write.statusCode).toBe(204);

    const body = bodyOf(await request("GET", "/api/keyboards/apex-pro-gen-3/mappings"));
    expect(body.remappedCount).toBe(2);

    const a = body.keys.find((k: { hidCode: number }) => k.hidCode === A);
    expect(a.isRemapped).toBe(true);
    expect(a.mappedTo.name).toBe("Z");
    expect(a.mappedTo.hidCodeHex).toBe("0x1D");
  });

  it("accepts hex strings and decimal alike", async () => {
    const response = await request("POST", "/api/keyboards/apex-pro-gen-3/mappings", {
      body: { mappings: [{ from: "0x04", to: "0x1D" }, { from: 5, to: 6 }, { from: "57", to: "224" }] },
    });
    expect(response.statusCode).toBe(204);
    expect(bodyOf(await request("GET", "/api/keyboards/apex-pro-gen-3/mappings")).remappedCount).toBe(3);
  });

  it("POST adds incrementally", async () => {
    await request("POST", "/api/keyboards/apex-pro-gen-3/mappings", { body: mappings([A, Z]) });
    await request("POST", "/api/keyboards/apex-pro-gen-3/mappings", { body: mappings([0x39, 0xe0]) });
    expect(bodyOf(await request("GET", "/api/keyboards/apex-pro-gen-3/mappings")).remappedCount).toBe(2);
  });

  it("PUT replaces the whole set and is idempotent", async () => {
    await request("POST", "/api/keyboards/apex-pro-gen-3/mappings", { body: mappings([A, Z], [B, C]) });
    await request("PUT", "/api/keyboards/apex-pro-gen-3/mappings", { body: mappings([0x39, 0xe0]) });
    expect(bodyOf(await request("GET", "/api/keyboards/apex-pro-gen-3/mappings")).remappedCount).toBe(1);

    await request("PUT", "/api/keyboards/apex-pro-gen-3/mappings", { body: mappings([0x39, 0xe0]) });
    expect(bodyOf(await request("GET", "/api/keyboards/apex-pro-gen-3/mappings")).remappedCount).toBe(1);
  });

  /** The regression that validate-then-merge hid in both implementations. */
  it("clears an override when a key is mapped to itself", async () => {
    await request("POST", "/api/keyboards/apex-pro-gen-3/mappings", { body: mappings([A, Z], [B, C]) });
    await request("POST", "/api/keyboards/apex-pro-gen-3/mappings", { body: mappings([A, A]) });

    const body = bodyOf(await request("GET", "/api/keyboards/apex-pro-gen-3/mappings"));
    expect(body.remappedCount).toBe(1);
    expect(
      body.keys.filter((k: { isRemapped: boolean }) => k.isRemapped).map((k: { hidCode: number }) => k.hidCode),
    ).toEqual([B]);
  });

  it("allows two keys to target the same key", async () => {
    const response = await request("POST", "/api/keyboards/apex-pro-gen-3/mappings", {
      body: mappings([A, Z], [B, Z]),
    });
    expect(response.statusCode).toBe(204);
    expect(bodyOf(await request("GET", "/api/keyboards/apex-pro-gen-3/mappings")).remappedCount).toBe(2);
  });
});

describe("validation", () => {
  it("reports every failure at once, with the contract's exact wording", async () => {
    const response = await request("POST", "/api/keyboards/apex-pro-gen-3/mappings", {
      body: mappings([A, NOT_A_KEY], [B, C], [B, 0x07]),
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers?.["Content-Type"]).toBe("application/problem+json");

    const body = bodyOf(response);
    expect(body.detail).toBe("The request contained 2 invalid mappings.");
    expect(body.errors).toHaveLength(2);
    expect(body.errors[0]).toEqual({
      index: 0,
      field: "to",
      message: "0x64 is not a key on Apex Pro Gen 3.",
    });
    expect(body.errors[1]).toEqual({
      index: 2,
      field: "from",
      message: "0x05 is remapped more than once in this request (also at index 1).",
    });
  });

  it("changes nothing when it rejects", async () => {
    await request("POST", "/api/keyboards/apex-pro-gen-3/mappings", { body: mappings([A, Z]) });
    await request("POST", "/api/keyboards/apex-pro-gen-3/mappings", { body: mappings([B, NOT_A_KEY]) });
    expect(bodyOf(await request("GET", "/api/keyboards/apex-pro-gen-3/mappings")).remappedCount).toBe(1);
  });

  it("rejects a body that is not an array of mappings", async () => {
    const response = await request("PUT", "/api/keyboards/apex-pro-gen-3/mappings", {
      body: { mappings: "nope" },
    });
    expect(response.statusCode).toBe(400);
    expect(bodyOf(response).errors[0].message).toBe("`mappings` must be an array.");
  });

  /** Omitted, not null — the shape the .NET side had to be corrected for. */
  it("omits `errors` from problems that have none", async () => {
    const body = bodyOf(await request("GET", "/api/keyboards/model-m/mappings"));
    expect(Object.keys(body).sort()).toEqual(["detail", "status", "title", "type"]);
  });
});

describe("deleting", () => {
  it("clears one key and is idempotent", async () => {
    await request("POST", "/api/keyboards/apex-pro-gen-3/mappings", { body: mappings([A, Z], [B, C]) });

    expect((await request("DELETE", "/api/keyboards/apex-pro-gen-3/mappings/0x04")).statusCode).toBe(204);
    expect((await request("DELETE", "/api/keyboards/apex-pro-gen-3/mappings/0x04")).statusCode).toBe(204);
    expect(bodyOf(await request("GET", "/api/keyboards/apex-pro-gen-3/mappings")).remappedCount).toBe(1);
  });

  it("rejects a code that is not a key on this keyboard", async () => {
    const response = await request("DELETE", "/api/keyboards/apex-pro-gen-3/mappings/0x64");
    expect(response.statusCode).toBe(400);
    expect(bodyOf(response).errors[0].message).toBe("0x64 is not a key on Apex Pro Gen 3.");
  });

  it("clears everything", async () => {
    await request("POST", "/api/keyboards/apex-pro-gen-3/mappings", { body: mappings([A, Z], [B, C]) });
    expect((await request("DELETE", "/api/keyboards/apex-pro-gen-3/mappings")).statusCode).toBe(204);
    expect(bodyOf(await request("GET", "/api/keyboards/apex-pro-gen-3/mappings")).remappedCount).toBe(0);
  });
});

describe("per-user isolation", () => {
  it("keeps one user's layout invisible to another", async () => {
    await request("POST", "/api/keyboards/apex-pro-gen-3/mappings", { sub: "alice", body: mappings([A, Z]) });

    const alice = bodyOf(await request("GET", "/api/keyboards/apex-pro-gen-3/mappings", { sub: "alice" }));
    const bob = bodyOf(await request("GET", "/api/keyboards/apex-pro-gen-3/mappings", { sub: "bob" }));

    expect(alice.remappedCount).toBe(1);
    expect(bob.remappedCount).toBe(0);
    expect(bob.totalKeys).toBe(92);
  });

  it("reports ownership per user", async () => {
    await request("POST", "/api/keyboards/apex-pro-gen-3/mappings", { sub: "alice", body: mappings([A, Z]) });

    const alice = bodyOf(await request("GET", "/api/keyboards", { sub: "alice" }));
    const bob = bodyOf(await request("GET", "/api/keyboards", { sub: "bob" }));

    expect(alice.keyboards[0].owned).toBe(true);
    expect(bob.keyboards[0].owned).toBe(false);
    expect(alice.keyboards[0].totalKeys).toBe(92);
  });
});
