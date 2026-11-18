using System.Text.Json;

namespace Apex.KeyMapping.Api.Domain;

/// <param name="Mappings">
/// Normalized, de-duplicated, identity-stripped mappings. Only meaningful when
/// <paramref name="Ok"/> is true.
/// </param>
/// <param name="Cleared">
/// Keys the request explicitly mapped to themselves, meaning "clear this
/// override". Kept out of <paramref name="Mappings"/> so that only ever holds
/// genuine overrides, but reported rather than discarded: an identity mapping
/// is an instruction, and a caller that merges without it leaves the old
/// override in place.
/// </param>
public sealed record ValidationResult(
    bool Ok,
    IReadOnlyList<KeyMapping> Mappings,
    IReadOnlyList<int> Cleared,
    IReadOnlyList<ValidationError> Errors);

/// <summary>
/// Validates requested remappings against the keys that physically exist on a
/// keyboard.
///
/// This is a deliberate reimplementation of validateMappings() in
/// packages/hid-catalog/src/mappings.ts. The two must agree on accepted input
/// and on the exact text of every error, because the OpenAPI contract promises
/// one problem-details shape regardless of which backend answered. The
/// conformance suite is what holds them together; this comment is only a
/// reminder that a change here needs a matching change there.
/// </summary>
public static class MappingValidator
{
    /// <summary>Aliases tolerated for the source key, in precedence order.</summary>
    private static readonly string[] FromNames = ["from", "fromHidCode", "key"];

    /// <summary>Aliases tolerated for the target key, in precedence order.</summary>
    private static readonly string[] ToNames = ["to", "toHidCode", "mappedTo"];

    /// <summary>
    /// Rules, all reported together rather than failing on the first problem:
    /// <list type="bullet">
    ///   <item><c>from</c> and <c>to</c> are required and must be 8-bit HID codes</item>
    ///   <item>both must be keys present on this keyboard</item>
    ///   <item>a physical key may appear only once as <c>from</c> in one request</item>
    /// </list>
    /// Two different keys may legitimately map to the same target, because a
    /// real keyboard can have two keys that both emit <c>A</c>.
    ///
    /// Mapping a key to itself is valid and means "no remap". It is kept out
    /// of <c>Mappings</c> so storage only holds genuine overrides, and
    /// surfaced in <c>Cleared</c> so the caller can remove whatever that key
    /// previously had.
    /// </summary>
    public static ValidationResult Validate(Keyboard keyboard, JsonElement input)
    {
        if (input.ValueKind != JsonValueKind.Array)
        {
            return new ValidationResult(
                false,
                [],
                [],
                [new ValidationError(-1, "mappings", "`mappings` must be an array.")]);
        }

        var errors = new List<ValidationError>();

        // Insertion-ordered so the response is deterministic before sorting.
        var normalized = new Dictionary<int, int>();
        var cleared = new SortedSet<int>();
        var seenFrom = new Dictionary<int, int>();

        var index = -1;
        foreach (var entry in input.EnumerateArray())
        {
            index++;

            if (entry.ValueKind != JsonValueKind.Object)
            {
                errors.Add(new ValidationError(
                    index, "mappings", "Each mapping must be an object with `from` and `to`."));
                continue;
            }

            var rawFrom = ReadField(entry, FromNames);
            var rawTo = ReadField(entry, ToNames);

            if (rawFrom is null) errors.Add(new ValidationError(index, "from", "`from` is required."));
            if (rawTo is null) errors.Add(new ValidationError(index, "to", "`to` is required."));
            if (rawFrom is null || rawTo is null) continue;

            var from = HidCode.Parse(rawFrom.Value);
            var to = HidCode.Parse(rawTo.Value);

            if (from is null) errors.Add(new ValidationError(index, "from", NotAHidCode(rawFrom.Value)));
            if (to is null) errors.Add(new ValidationError(index, "to", NotAHidCode(rawTo.Value)));
            if (from is null || to is null) continue;

            if (!keyboard.HasKey(from.Value))
                errors.Add(new ValidationError(index, "from", NotOnKeyboard(from.Value, keyboard)));
            if (!keyboard.HasKey(to.Value))
                errors.Add(new ValidationError(index, "to", NotOnKeyboard(to.Value, keyboard)));
            if (!keyboard.HasKey(from.Value) || !keyboard.HasKey(to.Value)) continue;

            if (seenFrom.TryGetValue(from.Value, out var previous))
            {
                errors.Add(new ValidationError(index, "from", RemappedTwice(from.Value, previous)));
                continue;
            }
            seenFrom[from.Value] = index;

            // A key mapped to itself carries no remap. It is kept out of
            // Mappings so storage only ever holds real overrides, but reported
            // in Cleared because it still means something: remove whatever
            // that key had.
            if (from.Value != to.Value) normalized[from.Value] = to.Value;
            else cleared.Add(from.Value);
        }

        if (errors.Count > 0) return new ValidationResult(false, [], [], errors);

        var mappings = normalized
            .Select(pair => new KeyMapping(pair.Key, pair.Value))
            .OrderBy(m => m.From)
            .ToArray();

        return new ValidationResult(true, mappings, [.. cleared], []);
    }

    private static JsonElement? ReadField(JsonElement entry, string[] names)
    {
        foreach (var name in names)
        {
            if (!entry.TryGetProperty(name, out var value)) continue;
            if (value.ValueKind == JsonValueKind.Null || value.ValueKind == JsonValueKind.Undefined) continue;
            return value;
        }
        return null;
    }

    // Note the en dash in "0–255": these strings are compared against the
    // TypeScript implementation's output, so the exact characters matter.
    private static string NotAHidCode(JsonElement value) =>
        $"{HidCode.Describe(value)} is not a valid 8-bit HID code (expected 0–255 or 0x00–0xFF).";

    private static string NotOnKeyboard(int hidCode, Keyboard keyboard) =>
        $"{HidCode.ToHex(hidCode)} is not a key on {keyboard.Name}.";

    private static string RemappedTwice(int hidCode, int previousIndex) =>
        $"{HidCode.ToHex(hidCode)} is remapped more than once in this request (also at index {previousIndex}).";

    /// <summary>
    /// Merges an incoming subset over the existing set: POST / upsert
    /// semantics.
    ///
    /// <para>
    /// <paramref name="cleared"/> carries the keys a request mapped to
    /// themselves, which <see cref="Validate"/> separates out. Pass it
    /// through, or a request asking to clear a binding silently leaves the old
    /// one in place — the identity mapping never reaches the <c>from == to</c>
    /// branch below, because validation removed it first.
    /// </para>
    /// </summary>
    public static IReadOnlyList<KeyMapping> Merge(
        IEnumerable<KeyMapping> existing,
        IEnumerable<KeyMapping> incoming,
        IEnumerable<int>? cleared = null)
    {
        var merged = existing.ToDictionary(m => m.From, m => m.To);

        foreach (var from in cleared ?? []) merged.Remove(from);

        foreach (var (from, to) in incoming)
        {
            if (from == to) merged.Remove(from);
            else merged[from] = to;
        }

        return merged
            .Select(pair => new KeyMapping(pair.Key, pair.Value))
            .OrderBy(m => m.From)
            .ToArray();
    }
}
