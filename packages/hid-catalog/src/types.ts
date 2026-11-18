/** A physical key as defined by the USB HID Usage Tables (Usage Page 0x07). */
export interface HidKey {
  /** 8-bit HID usage code, 0x00–0xFF. */
  readonly hidCode: number;
  /** Canonical uppercase hex rendering, e.g. `0x04`. */
  readonly hidCodeHex: string;
  /** Human label from the reference table, e.g. `A`, `Caps Lock`. */
  readonly name: string;
  /** Grouping used by the UI: Letters, Numbers, Special, Function, Arrows, Modifiers, Numpad. */
  readonly category: string;
}

/** A keyboard model and the set of keys available on it for remapping. */
export interface Keyboard {
  readonly slug: string;
  readonly name: string;
  readonly vendor: string;
  readonly keys: readonly HidKey[];
}

export interface Catalog {
  readonly keyboards: readonly Keyboard[];
}

/** A single remap: pressing `from` should produce `to`. */
export interface KeyMapping {
  readonly from: number;
  readonly to: number;
}

/**
 * One key's current state. `mappedTo` is always populated — an un-remapped key
 * maps to itself — so clients can render the effective layout without
 * special-casing. The assessment requires every key to appear, remapped or not.
 */
export interface KeyMappingView {
  readonly hidCode: number;
  readonly hidCodeHex: string;
  readonly name: string;
  readonly category: string;
  readonly isRemapped: boolean;
  readonly mappedTo: HidKey;
}

export interface KeyboardMappingsResponse {
  readonly keyboard: string;
  readonly keyboardSlug: string;
  readonly totalKeys: number;
  readonly remappedCount: number;
  readonly keys: readonly KeyMappingView[];
}

/** RFC 9457 problem details, matched field-for-field by the .NET API. */
export interface ValidationError {
  readonly index: number;
  readonly field: string;
  readonly message: string;
}

export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly errors?: readonly ValidationError[];
}
