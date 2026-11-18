using Apex.KeyMapping.Api.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Apex.KeyMapping.Api.Tests;

/// <summary>
/// The README claims the schema is a backstop under application validation:
/// "you cannot store a mapping to a key that does not exist on the keyboard
/// you own." These tests bypass the API entirely and write through the
/// DbContext, which is the only way to find out whether that is true.
///
/// <para>
/// Worth testing rather than assuming, because SQLite enforces foreign keys
/// per connection and ignores them unless asked. A claim about constraints
/// that nobody exercised is just a comment.
/// </para>
/// </summary>
public sealed class SchemaConstraintTests : IClassFixture<ApiFactory>
{
    private const int A = 0x04;
    private const int NotAKey = 0x64;

    private readonly ApiFactory _factory;

    public SchemaConstraintTests(ApiFactory factory) => _factory = factory;

    private async Task<(ApexDbContext Db, int UserKeyboardId)> SeedOwnedKeyboardAsync(IServiceScope scope)
    {
        var db = scope.ServiceProvider.GetRequiredService<ApexDbContext>();

        var owned = new UserKeyboard
        {
            OwnerSub = $"constraints-{Guid.NewGuid():N}",
            KeyboardModelId = CatalogSeed.KeyboardModelId,
            CreatedAt = DateTimeOffset.UtcNow,
        };

        db.UserKeyboards.Add(owned);
        await db.SaveChangesAsync();

        return (db, owned.Id);
    }

    [Fact]
    public async Task Foreign_keys_are_enforced_on_the_applications_own_connections()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ApexDbContext>();

        // Asked over the raw connection rather than through EF: PRAGMA is not
        // composable SQL, and this needs to report what the real connection is
        // configured with anyway.
        var connection = db.Database.GetDbConnection();
        if (connection.State != System.Data.ConnectionState.Open) await connection.OpenAsync();

        await using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA foreign_keys";

        Assert.Equal(1L, Convert.ToInt64(await command.ExecuteScalarAsync()));
    }

    [Fact]
    public async Task A_mapping_to_a_key_not_on_the_model_is_rejected_by_the_database()
    {
        using var scope = _factory.Services.CreateScope();
        var (db, userKeyboardId) = await SeedOwnedKeyboardAsync(scope);

        // 0x64 is a real HID usage code, but not a key on the Apex Pro Gen 3.
        db.KeyMappings.Add(new KeyMappingRow
        {
            UserKeyboardId = userKeyboardId,
            KeyboardModelId = CatalogSeed.KeyboardModelId,
            FromHidCode = A,
            ToHidCode = NotAKey,
            UpdatedAt = DateTimeOffset.UtcNow,
        });

        await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync());
    }

    [Fact]
    public async Task A_mapping_whose_model_disagrees_with_its_keyboard_is_rejected()
    {
        using var scope = _factory.Services.CreateScope();
        var (db, userKeyboardId) = await SeedOwnedKeyboardAsync(scope);

        // The composite FK into UserKeyboards(Id, KeyboardModelId) is what
        // stops a mapping from claiming a different model than the keyboard
        // it belongs to.
        db.KeyMappings.Add(new KeyMappingRow
        {
            UserKeyboardId = userKeyboardId,
            KeyboardModelId = CatalogSeed.KeyboardModelId + 99,
            FromHidCode = A,
            ToHidCode = 0x1D,
            UpdatedAt = DateTimeOffset.UtcNow,
        });

        await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync());
    }

    [Fact]
    public async Task A_physical_key_cannot_be_remapped_twice_on_one_keyboard()
    {
        using var firstScope = _factory.Services.CreateScope();
        var (db, userKeyboardId) = await SeedOwnedKeyboardAsync(firstScope);

        KeyMappingRow Remap(int to) => new()
        {
            UserKeyboardId = userKeyboardId,
            KeyboardModelId = CatalogSeed.KeyboardModelId,
            FromHidCode = A,
            ToHidCode = to,
            UpdatedAt = DateTimeOffset.UtcNow,
        };

        db.KeyMappings.Add(Remap(0x1D));
        await db.SaveChangesAsync();

        // A second context, because EF's change tracker would reject the
        // duplicate client-side and the point here is that the *database*
        // refuses it. The primary key makes "remapped at most once"
        // structural rather than a convention the code happens to follow.
        using var secondScope = _factory.Services.CreateScope();
        var other = secondScope.ServiceProvider.GetRequiredService<ApexDbContext>();

        other.KeyMappings.Add(Remap(0x05));

        await Assert.ThrowsAsync<DbUpdateException>(() => other.SaveChangesAsync());
    }

    [Fact]
    public async Task The_catalog_is_seeded_by_migration_not_by_code()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ApexDbContext>();

        var model = await db.KeyboardModels.AsNoTracking()
            .SingleAsync(m => m.Slug == CatalogSeed.Slug);
        var keyCount = await db.Keys.CountAsync(k => k.KeyboardModelId == model.Id);

        Assert.Equal("Apex Pro Gen 3", model.Name);
        Assert.Equal(CatalogSeed.Keys.Length, keyCount);
        Assert.Equal(92, keyCount);
    }
}
