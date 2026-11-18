import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { catalog } from "./catalog.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageRoot, "..", "..");

/**
 * The catalog exists in three places: the assessment's HidKeyCodes.md, the
 * generated keys.json that the .NET project embeds, and the generated TS
 * module the serverless API imports. If they drift, the two API
 * implementations stop agreeing and the assessment's reference table stops
 * being authoritative. These tests fail loudly when that happens.
 */
describe("catalog drift", () => {
  const keysJson = JSON.parse(readFileSync(join(packageRoot, "keys.json"), "utf8"));

  it("keys.json matches the compiled TypeScript module", () => {
    expect(keysJson.keyboards).toEqual(catalog.keyboards);
  });

  it("every key in HidKeyCodes.md is present in the catalog", () => {
    const doc = readFileSync(join(repoRoot, "HidKeyCodes.md"), "utf8");
    const documented = [...doc.matchAll(/^\|\s*([^|]+?)\s*\|\s*(0x[0-9A-Fa-f]{2})\s*\|/gm)]
      .map((m) => ({ name: m[1]!.trim(), hidCode: Number.parseInt(m[2]!, 16) }))
      // Skip the table header separator rows, which have no hex column match.
      .filter((row) => row.name !== "Key");

    expect(documented.length).toBeGreaterThan(0);

    const apex = catalog.keyboards.find((k) => k.slug === "apex-pro-gen-3")!;
    const byCode = new Map(apex.keys.map((k) => [k.hidCode, k]));

    for (const row of documented) {
      expect(byCode.get(row.hidCode), `HID ${row.hidCode} (${row.name}) missing from catalog`).toBeDefined();
    }
    expect(apex.keys.length).toBe(documented.length);
  });

  it("has no duplicate HID codes", () => {
    for (const keyboard of catalog.keyboards) {
      const codes = keyboard.keys.map((k) => k.hidCode);
      expect(new Set(codes).size).toBe(codes.length);
    }
  });

  it("keeps every code inside the 8-bit HID range", () => {
    for (const keyboard of catalog.keyboards) {
      for (const key of keyboard.keys) {
        expect(key.hidCode).toBeGreaterThanOrEqual(0x00);
        expect(key.hidCode).toBeLessThanOrEqual(0xff);
        expect(Number.isInteger(key.hidCode)).toBe(true);
      }
    }
  });

  it("renders hidCodeHex consistently with hidCode", () => {
    for (const keyboard of catalog.keyboards) {
      for (const key of keyboard.keys) {
        expect(key.hidCodeHex).toBe(`0x${key.hidCode.toString(16).toUpperCase().padStart(2, "0")}`);
      }
    }
  });

  it("covers the Apex Pro Gen 3 with the expected 92 keys", () => {
    const apex = catalog.keyboards.find((k) => k.slug === "apex-pro-gen-3")!;
    expect(apex.keys).toHaveLength(92);
    expect(apex.name).toBe("Apex Pro Gen 3");
  });

  /**
   * The .NET project cannot import this package, so it gets the catalog as
   * generated C# constants instead. That is the one place the two backends
   * could silently disagree about which keys exist, which is exactly what the
   * API contract promises they never do.
   */
  it("matches the generated C# seed the .NET migration is built from", () => {
    const seedPath = join(repoRoot, "apps", "api-dotnet", "Apex.KeyMapping.Api", "Data", "CatalogSeed.g.cs");
    const source = readFileSync(seedPath, "utf8");

    const seeded = [...source.matchAll(/^\s*\(0x([0-9A-F]{2}),\s*"((?:[^"\\]|\\.)*)",\s*"([^"]+)"\),$/gm)].map(
      (m) => ({
        hidCode: Number.parseInt(m[1]!, 16),
        name: m[2]!.replace(/\\(.)/g, "$1"),
        category: m[3]!,
      }),
    );

    const apex = catalog.keyboards.find((k) => k.slug === "apex-pro-gen-3")!;
    expect(seeded).toEqual(apex.keys.map(({ hidCode, name, category }) => ({ hidCode, name, category })));

    // The migration pins the model row by id, so the identity has to match too.
    expect(source).toContain(`public const string Slug = "${apex.slug}";`);
    expect(source).toContain(`public const string Name = "${apex.name}";`);
    expect(source).toContain(`public const string Vendor = "${apex.vendor}";`);
  });
});
