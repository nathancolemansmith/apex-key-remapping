import { generatedCatalog } from "./catalog.generated.js";
import type { Catalog, HidKey, Keyboard } from "./types.js";

export const catalog: Catalog = generatedCatalog;

export const keyboards: readonly Keyboard[] = catalog.keyboards;

const bySlug = new Map<string, Keyboard>(keyboards.map((k) => [k.slug, k]));

/** Accepts the slug (`apex-pro-gen-3`) or the display name (`Apex Pro Gen 3`). */
export function findKeyboard(identifier: string): Keyboard | undefined {
  const normalized = identifier.trim().toLowerCase();
  const direct = bySlug.get(normalized);
  if (direct) return direct;
  return keyboards.find((k) => k.name.toLowerCase() === normalized);
}

const keyIndex = new Map<string, Map<number, HidKey>>(
  keyboards.map((kb) => [kb.slug, new Map(kb.keys.map((key) => [key.hidCode, key]))]),
);

export function findKey(keyboard: Keyboard, hidCode: number): HidKey | undefined {
  return keyIndex.get(keyboard.slug)?.get(hidCode);
}

export function toHex(hidCode: number): string {
  return `0x${hidCode.toString(16).toUpperCase().padStart(2, "0")}`;
}

/**
 * Parses a HID code supplied as either a number (`4`) or a hex string
 * (`"0x04"`, `"0X04"`, `"04"`). Returns null when the value is not a valid
 * 8-bit integer, leaving the caller to report it as a field-level error.
 */
export function parseHidCode(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0x00 && value <= 0xff ? value : null;
  }
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (trimmed === "") return null;

  const hex = /^0[xX]([0-9A-Fa-f]{1,2})$/.exec(trimmed);
  if (hex?.[1]) return Number.parseInt(hex[1], 16);

  // Bare decimal, e.g. "29".
  if (/^\d{1,3}$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    return parsed >= 0x00 && parsed <= 0xff ? parsed : null;
  }

  // Bare two-digit hex, e.g. "1D". Only treated as hex when it cannot be
  // decimal, so "29" stays decimal 29 rather than becoming 0x29.
  if (/^[0-9A-Fa-f]{1,2}$/.test(trimmed)) return Number.parseInt(trimmed, 16);

  return null;
}
