/**
 * Physical layout of a full-size ANSI keyboard, in key units.
 *
 * One unit is one standard keycap. Positions are absolute rather than flowed,
 * because real keyboards have keys that span rows — numpad `+` and `Enter` are
 * two units tall — and the stepped offsets between rows are not derivable from
 * the order keys appear in.
 *
 * **Not every cap is remappable.** The catalog in HidKeyCodes.md describes 92
 * keys, and an ANSI board has more: the punctuation cluster and the Menu key
 * have no entry. Those are rendered as inert caps rather than omitted, because
 * a board with holes in it stops reading as a keyboard — and the gaps are
 * exactly where your eye expects something to be. They carry their real
 * legends, take no input, and are visibly dimmer.
 */

export interface KeyCap {
  /** Position of the cap's top-left corner, in key units. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** HID usage code, when this key is in the catalog and can be remapped. */
  readonly hidCode?: number;
  /** What is printed on the cap. Falls back to the catalog name. */
  readonly legend?: string;
  /** Smaller legend for the cap's second line, e.g. shifted symbols. */
  readonly sublegend?: string;
}

const U = 1;

/** Shorthand: a one-unit cap at (x, y). */
const k = (x: number, y: number, hidCode: number, legend?: string): KeyCap => ({
  x,
  y,
  w: U,
  h: U,
  hidCode,
  ...(legend ? { legend } : {}),
});

/** A cap that exists on the board but is not in the catalog. */
const blank = (x: number, y: number, legend: string, w = U, sublegend?: string): KeyCap => ({
  x,
  y,
  w,
  h: U,
  legend,
  ...(sublegend ? { sublegend } : {}),
});

/** A wider or taller cap that is remappable. */
const wide = (
  x: number,
  y: number,
  w: number,
  hidCode: number,
  legend: string,
  h = U,
): KeyCap => ({ x, y, w, h, hidCode, legend });

// Column origins. Standard full-size spacing: the main block is 15u, then a
// quarter-unit gutter, the navigation cluster, another gutter, the numpad.
const NAV = 15.5;
const NUM = 19.25;

export const LAYOUT: readonly KeyCap[] = [
  // ── Function row ──────────────────────────────────────────────────────────
  k(0, 0, 0x29, "Esc"),
  k(2, 0, 0x3a, "F1"),
  k(3, 0, 0x3b, "F2"),
  k(4, 0, 0x3c, "F3"),
  k(5, 0, 0x3d, "F4"),
  k(6.5, 0, 0x3e, "F5"),
  k(7.5, 0, 0x3f, "F6"),
  k(8.5, 0, 0x40, "F7"),
  k(9.5, 0, 0x41, "F8"),
  k(11, 0, 0x42, "F9"),
  k(12, 0, 0x43, "F10"),
  k(13, 0, 0x44, "F11"),
  k(14, 0, 0x45, "F12"),

  k(NAV, 0, 0x46, "PrtSc"),
  k(NAV + 1, 0, 0x47, "ScrLk"),
  k(NAV + 2, 0, 0x48, "Pause"),

  // ── Number row ────────────────────────────────────────────────────────────
  blank(0, 1.25, "~", U, "`"),
  k(1, 1.25, 0x1e, "1"),
  k(2, 1.25, 0x1f, "2"),
  k(3, 1.25, 0x20, "3"),
  k(4, 1.25, 0x21, "4"),
  k(5, 1.25, 0x22, "5"),
  k(6, 1.25, 0x23, "6"),
  k(7, 1.25, 0x24, "7"),
  k(8, 1.25, 0x25, "8"),
  k(9, 1.25, 0x26, "9"),
  k(10, 1.25, 0x27, "0"),
  blank(11, 1.25, "_", U, "-"),
  blank(12, 1.25, "+", U, "="),
  wide(13, 1.25, 2, 0x2a, "Backspace"),

  k(NAV, 1.25, 0x49, "Insert"),
  k(NAV + 1, 1.25, 0x4a, "Home"),
  k(NAV + 2, 1.25, 0x4b, "PgUp"),

  k(NUM, 1.25, 0x53, "Num"),
  k(NUM + 1, 1.25, 0x54, "/"),
  k(NUM + 2, 1.25, 0x55, "*"),
  k(NUM + 3, 1.25, 0x56, "−"),

  // ── Top alpha row ─────────────────────────────────────────────────────────
  wide(0, 2.25, 1.5, 0x2b, "Tab"),
  k(1.5, 2.25, 0x14, "Q"),
  k(2.5, 2.25, 0x1a, "W"),
  k(3.5, 2.25, 0x08, "E"),
  k(4.5, 2.25, 0x15, "R"),
  k(5.5, 2.25, 0x17, "T"),
  k(6.5, 2.25, 0x1c, "Y"),
  k(7.5, 2.25, 0x18, "U"),
  k(8.5, 2.25, 0x0c, "I"),
  k(9.5, 2.25, 0x12, "O"),
  k(10.5, 2.25, 0x13, "P"),
  blank(11.5, 2.25, "{", U, "["),
  blank(12.5, 2.25, "}", U, "]"),
  blank(13.5, 2.25, "|", 1.5, "\\"),

  k(NAV, 2.25, 0x4c, "Del"),
  k(NAV + 1, 2.25, 0x4d, "End"),
  k(NAV + 2, 2.25, 0x4e, "PgDn"),

  k(NUM, 2.25, 0x5f, "7"),
  k(NUM + 1, 2.25, 0x60, "8"),
  k(NUM + 2, 2.25, 0x61, "9"),
  wide(NUM + 3, 2.25, 1, 0x57, "+", 2),

  // ── Home row ──────────────────────────────────────────────────────────────
  wide(0, 3.25, 1.75, 0x39, "Caps Lock"),
  k(1.75, 3.25, 0x04, "A"),
  k(2.75, 3.25, 0x16, "S"),
  k(3.75, 3.25, 0x07, "D"),
  k(4.75, 3.25, 0x09, "F"),
  k(5.75, 3.25, 0x0a, "G"),
  k(6.75, 3.25, 0x0b, "H"),
  k(7.75, 3.25, 0x0d, "J"),
  k(8.75, 3.25, 0x0e, "K"),
  k(9.75, 3.25, 0x0f, "L"),
  blank(10.75, 3.25, ":", U, ";"),
  blank(11.75, 3.25, '"', U, "'"),
  wide(12.75, 3.25, 2.25, 0x28, "Enter"),

  k(NUM, 3.25, 0x5c, "4"),
  k(NUM + 1, 3.25, 0x5d, "5"),
  k(NUM + 2, 3.25, 0x5e, "6"),

  // ── Bottom alpha row ──────────────────────────────────────────────────────
  wide(0, 4.25, 2.25, 0xe1, "Shift"),
  k(2.25, 4.25, 0x1d, "Z"),
  k(3.25, 4.25, 0x1b, "X"),
  k(4.25, 4.25, 0x06, "C"),
  k(5.25, 4.25, 0x19, "V"),
  k(6.25, 4.25, 0x05, "B"),
  k(7.25, 4.25, 0x11, "N"),
  k(8.25, 4.25, 0x10, "M"),
  blank(9.25, 4.25, "<", U, ","),
  blank(10.25, 4.25, ">", U, "."),
  blank(11.25, 4.25, "?", U, "/"),
  wide(12.25, 4.25, 2.75, 0xe5, "Shift"),

  k(NAV + 1, 4.25, 0x52, "↑"),

  k(NUM, 4.25, 0x59, "1"),
  k(NUM + 1, 4.25, 0x5a, "2"),
  k(NUM + 2, 4.25, 0x5b, "3"),
  wide(NUM + 3, 4.25, 1, 0x58, "Enter", 2),

  // ── Modifier row ──────────────────────────────────────────────────────────
  wide(0, 5.25, 1.25, 0xe0, "Ctrl"),
  wide(1.25, 5.25, 1.25, 0xe3, "Win"),
  wide(2.5, 5.25, 1.25, 0xe2, "Alt"),
  wide(3.75, 5.25, 6.25, 0x2c, "Space"),
  wide(10, 5.25, 1.25, 0xe6, "Alt"),
  wide(11.25, 5.25, 1.25, 0xe7, "Win"),
  blank(12.5, 5.25, "Menu", 1.25),
  wide(13.75, 5.25, 1.25, 0xe4, "Ctrl"),

  k(NAV, 5.25, 0x50, "←"),
  k(NAV + 1, 5.25, 0x51, "↓"),
  k(NAV + 2, 5.25, 0x4f, "→"),

  wide(NUM, 5.25, 2, 0x62, "0"),
  k(NUM + 2, 5.25, 0x63, "."),
];

/** Overall board size in key units, used to size the chassis. */
export const BOARD = {
  width: Math.max(...LAYOUT.map((key) => key.x + key.w)),
  height: Math.max(...LAYOUT.map((key) => key.y + key.h)),
};

/** HID codes the layout can draw. Anything else has nowhere to go. */
export const PLACED_CODES: ReadonlySet<number> = new Set(
  LAYOUT.flatMap((key) => (key.hidCode === undefined ? [] : [key.hidCode])),
);
