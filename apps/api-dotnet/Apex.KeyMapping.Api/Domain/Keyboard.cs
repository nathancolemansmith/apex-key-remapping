namespace Apex.KeyMapping.Api.Domain;

/// <summary>A physical key as defined by the USB HID Usage Tables.</summary>
public sealed record HidKey(int HidCode, string HidCodeHex, string Name, string Category);

/// <summary>
/// A keyboard model and the keys available on it, as loaded from the database.
///
/// The catalog is rows in <c>KeyboardModels</c> and <c>Keys</c>, not a constant
/// compiled into the application, so this is a read model rather than a source
/// of truth. Validation needs to answer "is this a real key on this keyboard"
/// without a query per mapping, which is what the lookup here is for.
/// </summary>
public sealed class Keyboard
{
    private readonly Dictionary<int, HidKey> _byCode;

    public Keyboard(int id, string slug, string name, string vendor, IReadOnlyList<HidKey> keys)
    {
        Id = id;
        Slug = slug;
        Name = name;
        Vendor = vendor;
        Keys = keys;
        _byCode = keys.ToDictionary(k => k.HidCode);
    }

    public int Id { get; }
    public string Slug { get; }
    public string Name { get; }
    public string Vendor { get; }

    /// <summary>Every key on the model, in ascending HID code order.</summary>
    public IReadOnlyList<HidKey> Keys { get; }

    public HidKey? FindKey(int hidCode) => _byCode.GetValueOrDefault(hidCode);

    public bool HasKey(int hidCode) => _byCode.ContainsKey(hidCode);
}

/// <summary>A single remap: pressing <c>From</c> should produce <c>To</c>.</summary>
public readonly record struct KeyMapping(int From, int To);

/// <summary>One field-level reason a mapping was rejected.</summary>
/// <param name="Index">
/// Position in the submitted array, or -1 when the failure is with the array
/// itself rather than one entry.
/// </param>
public sealed record ValidationError(int Index, string Field, string Message);
