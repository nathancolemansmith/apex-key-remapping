import type { KeyMappingView } from "@apex/hid-catalog";
import { BOARD, LAYOUT, type KeyCap } from "../keyboardLayout.js";

interface Props {
  readonly keys: readonly KeyMappingView[];
  readonly selected: number | null;
  readonly pending: ReadonlyMap<number, number>;
  readonly flat: boolean;
  readonly onSelect: (hidCode: number) => void;
}

/**
 * The keyboard, drawn at its real proportions.
 *
 * Caps are absolutely positioned from the layout's unit grid, so one CSS
 * variable (`--cap`) scales the whole board and the geometry stays correct at
 * any size.
 *
 * Each cap is a real `<button>`. The 3D is a transform on their shared
 * ancestor, which means tab order, focus rings and screen-reader labels all
 * behave — none of which survives being drawn into a canvas.
 */
export function Keyboard({ keys, selected, pending, flat, onSelect }: Props) {
  const byCode = new Map(keys.map((key) => [key.hidCode, key]));

  return (
    // Two wrappers, not one. The viewport scrolls and establishes the size
    // container; the stage holds the perspective. One element doing both
    // breaks hit testing on the lower rows.
    <div className="kb-viewport">
      <div className="kb-stage">
        <div
          className="kb-chassis"
          data-flat={flat}
          style={{
            // n caps and n-1 gaps between them. Counting a trailing gap would
            // leave a sliver of dead plate on the right.
            width: `calc(${BOARD.width} * var(--cap) + ${BOARD.width - 1} * var(--gap))`,
          }}
        >
          <span className="kb-brand" aria-hidden="true">
            SteelSeries
          </span>

          <div
            className="kb-bed"
            style={{
              height: `calc(${BOARD.height} * var(--cap) + ${BOARD.height - 1} * var(--gap))`,
            }}
            role="group"
            aria-label="Keyboard layout"
          >
            {LAYOUT.map((cap) => (
              <Cap
                key={`${cap.x}-${cap.y}`}
                cap={cap}
                entry={cap.hidCode === undefined ? undefined : byCode.get(cap.hidCode)}
                isSelected={cap.hidCode !== undefined && cap.hidCode === selected}
                pendingTarget={cap.hidCode === undefined ? undefined : pending.get(cap.hidCode)}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Cap({
  cap,
  entry,
  isSelected,
  pendingTarget,
  onSelect,
}: {
  cap: KeyCap;
  entry: KeyMappingView | undefined;
  isSelected: boolean;
  pendingTarget: number | undefined;
  onSelect: (hidCode: number) => void;
}) {
  // Position and size from the unit grid. The gap is folded into the unit so
  // caps sit flush against their neighbours the way real ones do.
  const style = {
    left: `calc(${cap.x} * (var(--cap) + var(--gap)))`,
    top: `calc(${cap.y} * (var(--cap) + var(--gap)))`,
    width: `calc(${cap.w} * var(--cap) + ${cap.w - 1} * var(--gap))`,
    height: `calc(${cap.h} * var(--cap) + ${cap.h - 1} * var(--gap))`,
  };

  // A cap on the board that the catalog does not describe: shown so the
  // keyboard looks whole, but inert.
  if (!entry) {
    return (
      <button type="button" className="kb-cap" style={style} disabled tabIndex={-1} aria-hidden="true">
        <span className="kb-legend">{cap.legend}</span>
        {cap.sublegend && <span className="kb-sublegend">{cap.sublegend}</span>}
      </button>
    );
  }

  const hasPendingEdit = pendingTarget !== undefined;
  const target = hasPendingEdit ? pendingTarget : entry.mappedTo.hidCode;
  const isRemapped = target !== entry.hidCode;

  const state = hasPendingEdit && isRemapped ? "pending" : isRemapped ? "remapped" : undefined;
  const legend = cap.legend ?? entry.name;

  // The cap shows what it *produces*, not what is printed on it, because that
  // is the question someone configuring a keyboard is actually asking.
  const targetLabel = isRemapped ? (hasPendingEdit ? hexOf(target) : entry.mappedTo.name) : null;

  return (
    <button
      type="button"
      className="kb-cap"
      style={style}
      data-selected={isSelected}
      {...(state ? { "data-state": state } : {})}
      onClick={() => onSelect(entry.hidCode)}
      aria-pressed={isSelected}
      aria-label={
        isRemapped
          ? `${entry.name}, ${entry.hidCodeHex}, currently produces ${targetLabel}${hasPendingEdit ? ", unsaved" : ""}`
          : `${entry.name}, ${entry.hidCodeHex}, not remapped`
      }
      title={`${entry.name} · ${entry.hidCodeHex} · ${entry.category}`}
    >
      <span className="kb-legend">{legend}</span>
      {cap.sublegend && <span className="kb-sublegend">{cap.sublegend}</span>}
      {targetLabel && <span className="kb-target">→ {targetLabel}</span>}
    </button>
  );
}

const hexOf = (hidCode: number) => `0x${hidCode.toString(16).toUpperCase().padStart(2, "0")}`;
