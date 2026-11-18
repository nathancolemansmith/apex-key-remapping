import { describe, expect, it } from "vitest";
import { findKeyboard, parseHidCode, toHex } from "./catalog.js";
import { buildMappingsResponse, mergeMappings, validateMappings } from "./mappings.js";
import type { Keyboard } from "./types.js";

const apex: Keyboard = findKeyboard("apex-pro-gen-3")!;

describe("findKeyboard", () => {
  it("resolves by slug", () => {
    expect(findKeyboard("apex-pro-gen-3")?.name).toBe("Apex Pro Gen 3");
  });

  it("resolves by display name, case-insensitively", () => {
    expect(findKeyboard("Apex Pro Gen 3")?.slug).toBe("apex-pro-gen-3");
    expect(findKeyboard("apex pro gen 3")?.slug).toBe("apex-pro-gen-3");
  });

  it("returns undefined for an unknown keyboard", () => {
    expect(findKeyboard("Model M")).toBeUndefined();
  });
});

describe("parseHidCode", () => {
  it("accepts integers in range", () => {
    expect(parseHidCode(4)).toBe(4);
    expect(parseHidCode(0)).toBe(0);
    expect(parseHidCode(255)).toBe(255);
  });

  it("rejects integers out of 8-bit range", () => {
    expect(parseHidCode(-1)).toBeNull();
    expect(parseHidCode(256)).toBeNull();
  });

  it("rejects non-integers", () => {
    expect(parseHidCode(4.5)).toBeNull();
    expect(parseHidCode(Number.NaN)).toBeNull();
  });

  it("accepts 0x-prefixed hex in either case", () => {
    expect(parseHidCode("0x04")).toBe(4);
    expect(parseHidCode("0X1d")).toBe(29);
    expect(parseHidCode("0xE0")).toBe(224);
  });

  it("treats ambiguous bare digits as decimal", () => {
    // "29" is decimal 29 (Z), not 0x29 (41, Escape).
    expect(parseHidCode("29")).toBe(29);
  });

  it("treats bare non-decimal hex as hex", () => {
    expect(parseHidCode("1D")).toBe(29);
    expect(parseHidCode("e0")).toBe(224);
  });

  it("rejects junk", () => {
    expect(parseHidCode("")).toBeNull();
    expect(parseHidCode("   ")).toBeNull();
    expect(parseHidCode("0xZZ")).toBeNull();
    expect(parseHidCode("A key")).toBeNull();
    expect(parseHidCode(null)).toBeNull();
    expect(parseHidCode(undefined)).toBeNull();
    expect(parseHidCode({})).toBeNull();
  });
});

describe("validateMappings", () => {
  it("accepts the examples from the problem statement", () => {
    // "A (0x04)" -> "Z (0x1D)" and "4 (0x21)" -> "2 (0x1F)"
    const result = validateMappings(apex, [
      { from: "0x04", to: "0x1D" },
      { from: "0x21", to: "0x1F" },
    ]);

    expect(result.ok).toBe(true);
    expect(result.mappings).toEqual([
      { from: 0x04, to: 0x1d },
      { from: 0x21, to: 0x1f },
    ]);
  });

  it("accepts the canonical CapsLock -> Left Ctrl remap", () => {
    const result = validateMappings(apex, [{ from: 0x39, to: 0xe0 }]);
    expect(result.ok).toBe(true);
    expect(result.mappings).toEqual([{ from: 0x39, to: 0xe0 }]);
  });

  it("accepts an empty list as 'no remappings'", () => {
    const result = validateMappings(apex, []);
    expect(result.ok).toBe(true);
    expect(result.mappings).toEqual([]);
  });

  it("rejects a non-array body", () => {
    expect(validateMappings(apex, { from: 4, to: 5 }).ok).toBe(false);
    expect(validateMappings(apex, null).ok).toBe(false);
  });

  it("rejects a code that is valid HID but not on this keyboard", () => {
    // 0x64 (Non-US \) is a real HID code, but absent from HidKeyCodes.md.
    const result = validateMappings(apex, [{ from: 0x04, to: 0x64 }]);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { index: 0, field: "to", message: "0x64 is not a key on Apex Pro Gen 3." },
    ]);
  });

  it("rejects out-of-range codes as malformed rather than missing", () => {
    const result = validateMappings(apex, [{ from: 999, to: 0x04 }]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.field).toBe("from");
    expect(result.errors[0]?.message).toContain("not a valid 8-bit HID code");
  });

  it("reports missing fields", () => {
    const result = validateMappings(apex, [{ from: 0x04 }, { to: 0x04 }]);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { index: 0, field: "to", message: "`to` is required." },
      { index: 1, field: "from", message: "`from` is required." },
    ]);
  });

  it("rejects the same physical key remapped twice in one request", () => {
    const result = validateMappings(apex, [
      { from: 0x04, to: 0x1d },
      { from: 0x04, to: 0x05 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toEqual({
      index: 1,
      field: "from",
      message: "0x04 is remapped more than once in this request (also at index 0).",
    });
  });

  it("allows two different keys to target the same key", () => {
    // Legitimate: two physical keys can both emit 'A'.
    const result = validateMappings(apex, [
      { from: 0x04, to: 0x1d },
      { from: 0x05, to: 0x1d },
    ]);
    expect(result.ok).toBe(true);
    expect(result.mappings).toHaveLength(2);
  });

  it("normalizes an identity mapping away", () => {
    const result = validateMappings(apex, [
      { from: 0x04, to: 0x04 },
      { from: 0x05, to: 0x06 },
    ]);
    expect(result.ok).toBe(true);
    expect(result.mappings).toEqual([{ from: 0x05, to: 0x06 }]);
  });

  it("reports an identity mapping as a clear rather than discarding it", () => {
    const result = validateMappings(apex, [{ from: 0x04, to: 0x04 }]);
    expect(result.ok).toBe(true);
    expect(result.mappings).toEqual([]);
    expect(result.cleared).toEqual([0x04]);
  });

  it("collects every error instead of stopping at the first", () => {
    const result = validateMappings(apex, [
      { from: 0xff, to: 0xfe },
      { from: "nope", to: 0x04 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("accepts documented field aliases", () => {
    const result = validateMappings(apex, [{ key: "0x04", mappedTo: "0x1D" }]);
    expect(result.ok).toBe(true);
    expect(result.mappings).toEqual([{ from: 0x04, to: 0x1d }]);
  });

  it("returns mappings sorted by source key", () => {
    const result = validateMappings(apex, [
      { from: 0x1d, to: 0x04 },
      { from: 0x04, to: 0x1d },
    ]);
    expect(result.mappings.map((m) => m.from)).toEqual([0x04, 0x1d]);
  });
});

describe("buildMappingsResponse", () => {
  it("returns every key on the keyboard, remapped or not", () => {
    const response = buildMappingsResponse(apex, []);
    expect(response.keys).toHaveLength(apex.keys.length);
    expect(response.totalKeys).toBe(apex.keys.length);
    expect(response.remappedCount).toBe(0);
    expect(response.keyboard).toBe("Apex Pro Gen 3");
  });

  it("maps un-remapped keys to themselves so clients need no special case", () => {
    const response = buildMappingsResponse(apex, []);
    for (const key of response.keys) {
      expect(key.isRemapped).toBe(false);
      expect(key.mappedTo.hidCode).toBe(key.hidCode);
    }
  });

  it("reflects a stored remap", () => {
    const response = buildMappingsResponse(apex, [{ from: 0x04, to: 0x1d }]);
    const a = response.keys.find((k) => k.hidCode === 0x04)!;

    expect(a.name).toBe("A");
    expect(a.isRemapped).toBe(true);
    expect(a.mappedTo).toMatchObject({ hidCode: 0x1d, hidCodeHex: "0x1D", name: "Z" });
    expect(response.remappedCount).toBe(1);

    // The target key itself is untouched: remapping A->Z does not change Z.
    const z = response.keys.find((k) => k.hidCode === 0x1d)!;
    expect(z.isRemapped).toBe(false);
    expect(z.mappedTo.hidCode).toBe(0x1d);
  });

  it("returns keys in HID code order", () => {
    const codes = buildMappingsResponse(apex, []).keys.map((k) => k.hidCode);
    expect(codes).toEqual([...codes].sort((a, b) => a - b));
  });
});

describe("mergeMappings", () => {
  it("adds new overrides", () => {
    const merged = mergeMappings([{ from: 0x04, to: 0x1d }], [{ from: 0x05, to: 0x06 }]);
    expect(merged).toEqual([
      { from: 0x04, to: 0x1d },
      { from: 0x05, to: 0x06 },
    ]);
  });

  it("overwrites an existing override for the same key", () => {
    const merged = mergeMappings([{ from: 0x04, to: 0x1d }], [{ from: 0x04, to: 0x05 }]);
    expect(merged).toEqual([{ from: 0x04, to: 0x05 }]);
  });

  it("treats an identity mapping as a clear", () => {
    const merged = mergeMappings([{ from: 0x04, to: 0x1d }], [{ from: 0x04, to: 0x04 }]);
    expect(merged).toEqual([]);
  });

  /**
   * Regression: validate and merge were each correct alone, and wrong
   * together. validateMappings strips identity mappings, so the `from === to`
   * branch in mergeMappings never saw them and a POST asking to clear a
   * binding left the old one in place — contradicting the README and the
   * OpenAPI `clearOne` example. Only the composed path catches that, which is
   * why this test drives both functions the way the API does.
   */
  it("clears an existing override when a request maps a key to itself", () => {
    const existing = [{ from: 0x04, to: 0x1d }];
    const result = validateMappings(apex, [{ from: 0x04, to: 0x04 }]);

    expect(mergeMappings(existing, result.mappings, result.cleared)).toEqual([]);
  });

  it("clears one key while adding another in the same request", () => {
    const existing = [
      { from: 0x04, to: 0x1d },
      { from: 0x05, to: 0x06 },
    ];
    const result = validateMappings(apex, [
      { from: 0x04, to: 0x04 },
      { from: 0x07, to: 0x08 },
    ]);

    expect(mergeMappings(existing, result.mappings, result.cleared)).toEqual([
      { from: 0x05, to: 0x06 },
      { from: 0x07, to: 0x08 },
    ]);
  });
});

describe("toHex", () => {
  it("pads and uppercases", () => {
    expect(toHex(4)).toBe("0x04");
    expect(toHex(29)).toBe("0x1D");
    expect(toHex(224)).toBe("0xE0");
  });
});
