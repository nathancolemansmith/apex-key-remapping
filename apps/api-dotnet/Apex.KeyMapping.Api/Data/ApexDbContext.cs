using Microsoft.EntityFrameworkCore;

namespace Apex.KeyMapping.Api.Data;

/// <summary>
/// The persistence model. Two things are worth knowing about the shape here.
///
/// <para>
/// First, the key catalog is <em>rows</em>, not a constant: the migration
/// seeds <c>KeyboardModels</c> and <c>Keys</c>, and from then on the database
/// is the authoritative answer to which keys exist. Adding a keyboard is a
/// migration, not a recompile.
/// </para>
///
/// <para>
/// Second, the constraints do real work. Application validation runs first
/// because it reports every problem at once with a useful message, but the
/// schema is the backstop: composite foreign keys mean a mapping to a key that
/// is not on the owned keyboard cannot be stored even if a bug let it past
/// validation.
/// </para>
/// </summary>
public sealed class ApexDbContext(DbContextOptions<ApexDbContext> options) : DbContext(options)
{
    public DbSet<KeyboardModel> KeyboardModels => Set<KeyboardModel>();
    public DbSet<KeyboardKey> Keys => Set<KeyboardKey>();
    public DbSet<UserKeyboard> UserKeyboards => Set<UserKeyboard>();
    public DbSet<KeyMappingRow> KeyMappings => Set<KeyMappingRow>();

    protected override void OnModelCreating(ModelBuilder model)
    {
        model.Entity<KeyboardModel>(entity =>
        {
            entity.ToTable("KeyboardModels");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Id).ValueGeneratedNever();
            entity.HasIndex(e => e.Slug).IsUnique();
            entity.Property(e => e.Slug).IsRequired();
            entity.Property(e => e.Name).IsRequired();
            entity.Property(e => e.Vendor).IsRequired();

            entity.HasData(new KeyboardModel
            {
                Id = CatalogSeed.KeyboardModelId,
                Slug = CatalogSeed.Slug,
                Name = CatalogSeed.Name,
                Vendor = CatalogSeed.Vendor,
            });
        });

        model.Entity<KeyboardKey>(entity =>
        {
            entity.ToTable("Keys", t =>
                t.HasCheckConstraint("CK_Keys_HidCode_8Bit", "[HidCode] BETWEEN 0 AND 255"));

            // A HID code is unique per keyboard, not globally — two models can
            // both have a 0x04.
            entity.HasKey(e => new { e.KeyboardModelId, e.HidCode });
            entity.Property(e => e.Name).IsRequired();
            entity.Property(e => e.Category).IsRequired();

            entity.HasOne(e => e.KeyboardModel)
                .WithMany(m => m.Keys)
                .HasForeignKey(e => e.KeyboardModelId)
                .OnDelete(DeleteBehavior.Cascade);

            // Retiring a model takes its keys with it.
            entity.HasData(CatalogSeed.Keys.Select(k => new
            {
                KeyboardModelId = CatalogSeed.KeyboardModelId,
                HidCode = k.HidCode,
                Name = k.Name,
                Category = k.Category,
            }));
        });

        model.Entity<UserKeyboard>(entity =>
        {
            entity.ToTable("UserKeyboards");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.OwnerSub).IsRequired();

            // One Apex Pro Gen 3 per user.
            entity.HasIndex(e => new { e.OwnerSub, e.KeyboardModelId }).IsUnique();

            // Not redundant with the primary key: this is the principal key
            // KeyMappings points at, and it is what stops a mapping's model
            // from disagreeing with the keyboard it belongs to.
            entity.HasAlternateKey(e => new { e.Id, e.KeyboardModelId });

            entity.HasOne(e => e.KeyboardModel)
                .WithMany()
                .HasForeignKey(e => e.KeyboardModelId)
                .OnDelete(DeleteBehavior.Restrict);
        });

        model.Entity<KeyMappingRow>(entity =>
        {
            entity.ToTable("KeyMappings");

            // "A physical key is remapped at most once" made structural, so a
            // duplicate add cannot corrupt state.
            entity.HasKey(e => new { e.UserKeyboardId, e.FromHidCode });

            // The model must be the one this user's keyboard actually is.
            entity.HasOne(e => e.UserKeyboard)
                .WithMany(k => k.Mappings)
                .HasForeignKey(e => new { e.UserKeyboardId, e.KeyboardModelId })
                .HasPrincipalKey(k => new { k.Id, k.KeyboardModelId })
                .OnDelete(DeleteBehavior.Cascade);

            // ...and both ends must be real keys on that model. These two are
            // the constraints that make an impossible remap unstorable.
            entity.HasOne<KeyboardKey>()
                .WithMany()
                .HasForeignKey(e => new { e.KeyboardModelId, e.FromHidCode })
                .OnDelete(DeleteBehavior.Restrict);

            entity.HasOne<KeyboardKey>()
                .WithMany()
                .HasForeignKey(e => new { e.KeyboardModelId, e.ToHidCode })
                .OnDelete(DeleteBehavior.Restrict);
        });
    }
}
