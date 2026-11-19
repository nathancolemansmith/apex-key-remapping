import { catalog } from "@apex/hid-catalog";
import { describe, expect, it } from "vitest";
import { LAYOUT, PLACED_CODES } from "./keyboardLayout.js";

const apex = catalog.keyboards.find((keyboard) => keyboard.slug === "apex-pro-gen-3")!;

describe("physical layout", () => {
  /**
   * The failure this prevents is quiet: a key added to the catalog but not to
   * the layout still appears in the API response and is still remappable by
   * the contract, but has nowhere to be drawn — so it becomes unreachable in
   * the UI with nothing to indicate it is missing.
   */
  it("gives every catalog key somewhere to live", () => {
    const missing = apex.keys
      .filter((key) => !PLACED_CODES.has(key.hidCode))
      .map((key) => `${key.hidCodeHex} ${key.name}`);

    expect(missing, "add these to LAYOUT in keyboardLayout.ts").toEqual([]);
  });

  it("does not invent keys the catalog has never heard of", () => {
    const known = new Set(apex.keys.map((key) => key.hidCode));
    expect([...PLACED_CODES].filter((code) => !known.has(code))).toEqual([]);
  });

  it("places each key exactly once", () => {
    const placed = LAYOUT.flatMap((cap) => (cap.hidCode === undefined ? [] : [cap.hidCode]));
    expect(placed).toHaveLength(new Set(placed).size);
    expect(placed).toHaveLength(apex.keys.length);
  });

  /** Overlapping caps would render on top of each other. */
  it("has no two caps occupying the same cell", () => {
    const occupied = new Map<string, string>();

    for (const cap of LAYOUT) {
      const label = cap.legend ?? `0x${cap.hidCode?.toString(16)}`;
      // Caps are placed on a quarter-unit grid; sample at that resolution.
      for (let x = cap.x; x < cap.x + cap.w; x += 0.25) {
        for (let y = cap.y; y < cap.y + cap.h; y += 0.25) {
          const cell = `${x.toFixed(2)},${y.toFixed(2)}`;
          expect(occupied.get(cell), `${label} overlaps ${occupied.get(cell)} at ${cell}`).toBeUndefined();
          occupied.set(cell, label);
        }
      }
    }
  });
});
