import type { KeyMappingView } from "@apex/hid-catalog";

interface Props {
  readonly keys: readonly KeyMappingView[];
  readonly selected: number | null;
  readonly pending: ReadonlyMap<number, number>;
  readonly onSelect: (hidCode: number) => void;
}

/**
 * Every key on the keyboard, grouped by category.
 *
 * The API returns all 92 keys whether remapped or not, which is what the
 * brief asks for and what makes this component simple: it renders what it is
 * given in the order it is given, with no notion of a default layout to
 * reconcile against.
 */
export function KeyboardGrid({ keys, selected, pending, onSelect }: Props) {
  const categories = [...new Set(keys.map((key) => key.category))];

  return (
    <>
      {categories.map((category) => (
        <section key={category} className="mb-4">
          <h6 className="text-uppercase text-body-secondary small fw-bold mb-2">
            {category}
            <span className="ms-2 fw-normal opacity-75">
              {keys.filter((k) => k.category === category).length}
            </span>
          </h6>

          <div className="d-flex flex-wrap gap-2">
            {keys
              .filter((key) => key.category === category)
              .map((key) => (
                <KeyCap
                  key={key.hidCode}
                  entry={key}
                  isSelected={selected === key.hidCode}
                  pendingTarget={pending.get(key.hidCode)}
                  onSelect={onSelect}
                />
              ))}
          </div>
        </section>
      ))}
    </>
  );
}

function KeyCap({
  entry,
  isSelected,
  pendingTarget,
  onSelect,
}: {
  entry: KeyMappingView;
  isSelected: boolean;
  pendingTarget: number | undefined;
  onSelect: (hidCode: number) => void;
}) {
  // Three states worth distinguishing: saved remap, unsaved edit, untouched.
  // Unsaved is the one people lose track of, so it gets the loudest styling.
  const hasPendingEdit = pendingTarget !== undefined;
  const isRemapped = hasPendingEdit ? pendingTarget !== entry.hidCode : entry.isRemapped;

  const variant = hasPendingEdit
    ? "btn-warning"
    : isRemapped
      ? "btn-primary"
      : "btn-outline-secondary";

  const target = hasPendingEdit ? pendingTarget : entry.mappedTo.hidCode;

  return (
    <button
      type="button"
      className={`btn ${variant} btn-sm text-start position-relative ${isSelected ? "ring" : ""}`}
      style={{ minWidth: "5.5rem" }}
      onClick={() => onSelect(entry.hidCode)}
      aria-pressed={isSelected}
      title={`${entry.name} — ${entry.hidCodeHex}`}
    >
      <div className="fw-semibold text-truncate">{entry.name}</div>
      <div className="font-monospace opacity-75" style={{ fontSize: "0.7rem" }}>
        {entry.hidCodeHex}
      </div>

      {isRemapped && target !== entry.hidCode && (
        <div className="small text-truncate" style={{ fontSize: "0.7rem" }}>
          → {hasPendingEdit ? `0x${target.toString(16).toUpperCase().padStart(2, "0")}` : entry.mappedTo.name}
        </div>
      )}
    </button>
  );
}
