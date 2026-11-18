import { findKey, parseHidCode, toHex } from "./catalog.js";
import type {
  HidKey,
  Keyboard,
  KeyMapping,
  KeyboardMappingsResponse,
  KeyMappingView,
  ValidationError,
} from "./types.js";

export interface ValidationResult {
  readonly ok: boolean;
  /** Normalized, de-duplicated, identity-stripped mappings. Only set when ok. */
  readonly mappings: readonly KeyMapping[];
  /**
   * Keys the request explicitly mapped to themselves, meaning "clear this
   * override". Kept separate from `mappings` so the latter only ever holds
   * genuine overrides — which is what makes PUT trivially correct and
   * `remappedCount` honest.
   *
   * These have to be reported rather than silently dropped: an identity
   * mapping is an instruction, not a no-op, and a caller that merges without
   * it will leave the old override in place.
   */
  readonly cleared: readonly number[];
  readonly errors: readonly ValidationError[];
}

interface RawMapping {
  from?: unknown;
  to?: unknown;
  /** Tolerated aliases so the API is forgiving about naming. */
  fromHidCode?: unknown;
  toHidCode?: unknown;
  key?: unknown;
  mappedTo?: unknown;
}

function readField(raw: RawMapping, ...names: (keyof RawMapping)[]): unknown {
  for (const name of names) {
    if (raw[name] !== undefined && raw[name] !== null) return raw[name];
  }
  return undefined;
}

/**
 * Validates a requested set of remappings against the keys that physically
 * exist on `keyboard`.
 *
 * Rules, all reported together rather than failing on the first problem:
 *  - `from` and `to` are required and must be 8-bit HID codes
 *  - both must be keys present on this keyboard
 *  - a physical key may appear only once as `from` in one request
 *
 * Two different keys may legitimately map to the same target (a real keyboard
 * can have two keys that both emit `A`), so that is allowed.
 *
 * Mapping a key to itself is valid and normalized away: it means "no remap".
 */
export function validateMappings(keyboard: Keyboard, input: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (!Array.isArray(input)) {
    return {
      ok: false,
      mappings: [],
      cleared: [],
      errors: [{ index: -1, field: "mappings", message: "`mappings` must be an array." }],
    };
  }

  const normalized = new Map<number, number>();
  const cleared = new Set<number>();
  const seenFrom = new Map<number, number>();

  input.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push({ index, field: "mappings", message: "Each mapping must be an object with `from` and `to`." });
      return;
    }

    const raw = entry as RawMapping;
    const rawFrom = readField(raw, "from", "fromHidCode", "key");
    const rawTo = readField(raw, "to", "toHidCode", "mappedTo");

    if (rawFrom === undefined) {
      errors.push({ index, field: "from", message: "`from` is required." });
    }
    if (rawTo === undefined) {
      errors.push({ index, field: "to", message: "`to` is required." });
    }
    if (rawFrom === undefined || rawTo === undefined) return;

    const from = parseHidCode(rawFrom);
    const to = parseHidCode(rawTo);

    if (from === null) {
      errors.push({
        index,
        field: "from",
        message: `${describe(rawFrom)} is not a valid 8-bit HID code (expected 0–255 or 0x00–0xFF).`,
      });
    }
    if (to === null) {
      errors.push({
        index,
        field: "to",
        message: `${describe(rawTo)} is not a valid 8-bit HID code (expected 0–255 or 0x00–0xFF).`,
      });
    }
    if (from === null || to === null) return;

    if (!findKey(keyboard, from)) {
      errors.push({ index, field: "from", message: `${toHex(from)} is not a key on ${keyboard.name}.` });
    }
    if (!findKey(keyboard, to)) {
      errors.push({ index, field: "to", message: `${toHex(to)} is not a key on ${keyboard.name}.` });
    }
    if (!findKey(keyboard, from) || !findKey(keyboard, to)) return;

    const previous = seenFrom.get(from);
    if (previous !== undefined) {
      errors.push({
        index,
        field: "from",
        message: `${toHex(from)} is remapped more than once in this request (also at index ${previous}).`,
      });
      return;
    }
    seenFrom.set(from, index);

    // A key mapped to itself carries no remap. It is kept out of `mappings`
    // so storage only ever holds real overrides, but reported in `cleared`
    // because it still means something: remove whatever that key had.
    if (from !== to) normalized.set(from, to);
    else cleared.add(from);
  });

  if (errors.length > 0) return { ok: false, mappings: [], cleared: [], errors };

  const mappings = [...normalized.entries()]
    .map(([from, to]) => ({ from, to }))
    .sort((a, b) => a.from - b.from);

  return { ok: true, mappings, cleared: [...cleared].sort((a, b) => a - b), errors: [] };
}

function describe(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return String(value);
}

/**
 * Projects stored overrides onto the full key list. Every key on the keyboard
 * is returned, in HID code order, whether remapped or not.
 */
export function buildMappingsResponse(
  keyboard: Keyboard,
  overrides: readonly KeyMapping[],
): KeyboardMappingsResponse {
  const overrideByFrom = new Map(overrides.map((m) => [m.from, m.to]));

  const keys: KeyMappingView[] = keyboard.keys.map((key) => {
    const target = overrideByFrom.get(key.hidCode);
    const mappedTo: HidKey = target === undefined ? key : (findKey(keyboard, target) ?? key);
    return {
      hidCode: key.hidCode,
      hidCodeHex: key.hidCodeHex,
      name: key.name,
      category: key.category,
      isRemapped: target !== undefined && target !== key.hidCode,
      mappedTo,
    };
  });

  return {
    keyboard: keyboard.name,
    keyboardSlug: keyboard.slug,
    totalKeys: keys.length,
    remappedCount: keys.filter((k) => k.isRemapped).length,
    keys,
  };
}

/**
 * Merges an incoming subset over the existing set (POST / upsert semantics).
 *
 * `cleared` carries the keys a request mapped to themselves, which
 * `validateMappings` separates out. Pass it through, or a request that asks to
 * clear a binding will silently leave the old one in place — the identity
 * mapping never reaches the `from === to` branch below, because validation
 * removed it first.
 */
export function mergeMappings(
  existing: readonly KeyMapping[],
  incoming: readonly KeyMapping[],
  cleared: readonly number[] = [],
): readonly KeyMapping[] {
  const merged = new Map(existing.map((m) => [m.from, m.to]));
  for (const from of cleared) merged.delete(from);
  for (const { from, to } of incoming) {
    if (from === to) merged.delete(from);
    else merged.set(from, to);
  }
  return [...merged.entries()].map(([from, to]) => ({ from, to })).sort((a, b) => a.from - b.from);
}
