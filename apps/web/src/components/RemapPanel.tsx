import type { KeyMappingView } from "@apex/hid-catalog";

interface Props {
  readonly keys: readonly KeyMappingView[];
  readonly selected: KeyMappingView | null;
  readonly pendingTarget: number | undefined;
  readonly onChange: (from: number, to: number) => void;
  readonly onClear: (from: number) => void;
  readonly onDismiss: () => void;
}

/**
 * Editor for whichever key is selected.
 *
 * The target list is every key on the keyboard, because the API permits any
 * key to map to any other — including two keys targeting the same one, which
 * a real keyboard can do. The only option that needs explaining is mapping a
 * key to itself, which the contract defines as "clear this override".
 */
export function RemapPanel({
  keys,
  selected,
  pendingTarget,
  onChange,
  onClear,
  onDismiss,
}: Props) {
  if (!selected) {
    return (
      <div className="card bg-body-tertiary border-0">
        <div className="card-body text-body-secondary small">
          Pick a key to remap it.
        </div>
      </div>
    );
  }

  const current = pendingTarget ?? selected.mappedTo.hidCode;
  const isRemapped = current !== selected.hidCode;

  return (
    <div className="card bg-body-tertiary border-0">
      <div className="card-body">
        <div className="d-flex justify-content-between align-items-start mb-3">
          <div>
            <div className="fs-5 fw-semibold">{selected.name}</div>
            <div className="font-monospace small text-body-secondary">
              {selected.hidCodeHex} · {selected.category}
            </div>
          </div>
          <button
            type="button"
            className="btn-close"
            aria-label="Close"
            onClick={onDismiss}
          />
        </div>

        <label htmlFor="target" className="form-label small text-body-secondary">
          Pressing this key should produce
        </label>
        <select
          id="target"
          className="form-select mb-3"
          value={current}
          onChange={(event) => onChange(selected.hidCode, Number(event.target.value))}
        >
          {keys.map((key) => (
            <option key={key.hidCode} value={key.hidCode}>
              {key.name} ({key.hidCodeHex})
              {key.hidCode === selected.hidCode ? " — no remap" : ""}
            </option>
          ))}
        </select>

        {isRemapped && (
          <button
            type="button"
            className="btn btn-outline-secondary btn-sm w-100"
            onClick={() => onClear(selected.hidCode)}
          >
            Clear this remap
          </button>
        )}
      </div>
    </div>
  );
}
