namespace Apex.KeyMapping.Api.Data;

/// <summary>
/// A keyboard model. Product catalog: seeded by migration, shared by every
/// user. "An Apex Pro Gen 3 has these 92 keys" is true for everyone.
/// </summary>
public sealed class KeyboardModel
{
    public int Id { get; set; }
    public required string Slug { get; set; }
    public required string Name { get; set; }
    public required string Vendor { get; set; }

    public List<KeyboardKey> Keys { get; set; } = [];
}

/// <summary>
/// A physical key on a model. Part of the seeded catalog, keyed by
/// (model, HID code) so a code is unique per keyboard rather than globally.
/// </summary>
public sealed class KeyboardKey
{
    public int KeyboardModelId { get; set; }
    public int HidCode { get; set; }
    public required string Name { get; set; }
    public required string Category { get; set; }

    public KeyboardModel? KeyboardModel { get; set; }
}

/// <summary>
/// One keyboard a user owns, created on that user's first write. This is where
/// the shared product catalog stops and per-user data begins.
/// </summary>
public sealed class UserKeyboard
{
    public int Id { get; set; }

    /// <summary>The Cognito <c>sub</c> claim. Never supplied by the client.</summary>
    public required string OwnerSub { get; set; }

    public int KeyboardModelId { get; set; }
    public DateTimeOffset CreatedAt { get; set; }

    public KeyboardModel? KeyboardModel { get; set; }
    public List<KeyMappingRow> Mappings { get; set; } = [];
}

/// <summary>
/// A stored remap belonging to one owned keyboard. Mapped to the
/// <c>KeyMappings</c> table; the class is named <c>Row</c> to keep it distinct
/// from <see cref="Domain.KeyMapping"/>, which is the domain value the API
/// works in.
///
/// <para>
/// <see cref="KeyboardModelId"/> is carried here deliberately. It is redundant
/// with the owning <see cref="UserKeyboard"/>, and that redundancy is what
/// makes the composite foreign keys into <c>Keys</c> expressible — so the
/// database itself can refuse a remap whose source or target is not a real key
/// on that model.
/// </para>
/// </summary>
public sealed class KeyMappingRow
{
    public int UserKeyboardId { get; set; }
    public int KeyboardModelId { get; set; }
    public int FromHidCode { get; set; }
    public int ToHidCode { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }

    public UserKeyboard? UserKeyboard { get; set; }
}
