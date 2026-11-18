using Apex.KeyMapping.Api.Domain;

namespace Apex.KeyMapping.Api.Contracts;

/// <summary>
/// Response shapes for the API. These are the C# expression of
/// packages/api-contract/openapi.yaml; the property names here are what the
/// generated OpenAPI document is diffed against, so renaming one is a contract
/// change rather than a refactor.
/// </summary>
public sealed record KeyboardSummary(
    string Slug,
    string Name,
    string Vendor,
    int TotalKeys,
    bool Owned);

public sealed record KeyboardListResponse(IReadOnlyList<KeyboardSummary> Keyboards);

/// <summary>
/// One key's current state. <c>MappedTo</c> is always populated — an
/// un-remapped key maps to itself — so a client can render the effective
/// layout without special-casing either state.
/// </summary>
public sealed record KeyMappingView(
    int HidCode,
    string HidCodeHex,
    string Name,
    string Category,
    bool IsRemapped,
    HidKey MappedTo);

public sealed record KeyboardMappingsResponse(
    string Keyboard,
    string KeyboardSlug,
    int TotalKeys,
    int RemappedCount,
    IReadOnlyList<KeyMappingView> Keys)
{
    /// <summary>
    /// Projects stored overrides onto the full key list. Every key on the
    /// keyboard is returned, in HID code order, whether remapped or not, as
    /// the brief requires.
    /// </summary>
    public static KeyboardMappingsResponse Build(
        Domain.Keyboard keyboard,
        IEnumerable<Domain.KeyMapping> overrides)
    {
        var overrideByFrom = overrides.ToDictionary(m => m.From, m => m.To);

        var keys = keyboard.Keys
            .Select(key =>
            {
                var hasOverride = overrideByFrom.TryGetValue(key.HidCode, out var target);

                // A stored override always points at a real key — the schema's
                // composite foreign key guarantees it — but fall back to the
                // key itself rather than throwing if that ever stops holding.
                var mappedTo = hasOverride ? keyboard.FindKey(target) ?? key : key;

                return new KeyMappingView(
                    key.HidCode,
                    key.HidCodeHex,
                    key.Name,
                    key.Category,
                    hasOverride && target != key.HidCode,
                    mappedTo);
            })
            .ToArray();

        return new KeyboardMappingsResponse(
            keyboard.Name,
            keyboard.Slug,
            keys.Length,
            keys.Count(k => k.IsRemapped),
            keys);
    }
}
