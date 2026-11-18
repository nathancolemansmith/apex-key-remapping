using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Apex.KeyMapping.Api.Domain;

/// <summary>
/// Parsing and rendering of 8-bit USB HID usage codes.
///
/// This is the C# half of a rule that exists twice in this repository: the
/// TypeScript original lives in packages/hid-catalog/src/catalog.ts. The two
/// must agree exactly, including on the awkward cases, because the API
/// contract promises both backends accept the same inputs.
/// </summary>
public static partial class HidCode
{
    public const int Min = 0x00;
    public const int Max = 0xFF;

    [GeneratedRegex(@"^0[xX]([0-9A-Fa-f]{1,2})$")]
    private static partial Regex PrefixedHex();

    [GeneratedRegex(@"^\d{1,3}$")]
    private static partial Regex BareDecimal();

    [GeneratedRegex(@"^[0-9A-Fa-f]{1,2}$")]
    private static partial Regex BareHex();

    /// <summary>Canonical uppercase rendering, e.g. <c>0x04</c>.</summary>
    public static string ToHex(int hidCode) =>
        string.Create(CultureInfo.InvariantCulture, $"0x{hidCode:X2}");

    /// <summary>
    /// Parses a HID code supplied as a number (<c>4</c>) or a hex string
    /// (<c>"0x04"</c>, <c>"0X04"</c>, <c>"04"</c>). Returns null when the value
    /// is not a valid 8-bit integer, leaving the caller to report it as a
    /// field-level error rather than throwing.
    /// </summary>
    public static int? Parse(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Number => ParseNumber(value),
        JsonValueKind.String => Parse(value.GetString()),
        _ => null,
    };

    private static int? ParseNumber(JsonElement value)
    {
        // A non-integral or oversized number is a malformed code, not an error.
        if (!value.TryGetInt32(out var number)) return null;
        if (value.TryGetDouble(out var asDouble) && asDouble != Math.Floor(asDouble)) return null;
        return number is >= Min and <= Max ? number : null;
    }

    public static int? Parse(string? value)
    {
        if (value is null) return null;

        var trimmed = value.Trim();
        if (trimmed.Length == 0) return null;

        var prefixed = PrefixedHex().Match(trimmed);
        if (prefixed.Success)
        {
            return int.Parse(prefixed.Groups[1].ValueSpan, NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        }

        // Bare decimal, e.g. "29".
        if (BareDecimal().IsMatch(trimmed))
        {
            var parsed = int.Parse(trimmed, CultureInfo.InvariantCulture);
            return parsed is >= Min and <= Max ? parsed : null;
        }

        // Bare two-digit hex, e.g. "1D". Only treated as hex when it cannot be
        // decimal, so "29" stays decimal 29 rather than becoming 0x29.
        if (BareHex().IsMatch(trimmed))
        {
            return int.Parse(trimmed, NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        }

        return null;
    }

    /// <summary>
    /// Renders a rejected value for an error message. Mirrors `describe()` in
    /// mappings.ts so both backends produce byte-identical problem details.
    /// </summary>
    public static string Describe(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => $"\"{value.GetString()}\"",
        JsonValueKind.Number => value.GetRawText(),
        JsonValueKind.True => "true",
        JsonValueKind.False => "false",
        JsonValueKind.Array => "an array",
        JsonValueKind.Object => "an object",
        JsonValueKind.Null => "null",
        _ => "undefined",
    };
}
