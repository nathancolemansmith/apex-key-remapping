using Apex.KeyMapping.Api.Data;
using Apex.KeyMapping.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace Apex.KeyMapping.Api.Services;

/// <summary>
/// Everything the endpoints need from storage. Keeping it here rather than in
/// the route handlers means the per-user scoping lives in one place, which is
/// the part most worth being able to read in one sitting: every query below
/// filters by <c>ownerSub</c>, and nothing accepts an owner from the caller.
/// </summary>
public sealed class KeyboardService(ApexDbContext db, TimeProvider clock)
{
    /// <summary>
    /// Loads a model and its keys, by slug or display name, case-insensitively.
    /// Returns null when no such model exists, which the caller turns into a 404.
    /// </summary>
    public async Task<Keyboard?> FindKeyboardAsync(string identifier, CancellationToken ct = default)
    {
        var normalized = identifier.Trim().ToLowerInvariant();

        var model = await db.KeyboardModels
            .AsNoTracking()
            .Include(m => m.Keys)
            .FirstOrDefaultAsync(
                m => m.Slug.ToLower() == normalized || m.Name.ToLower() == normalized,
                ct);

        if (model is null) return null;

        var keys = model.Keys
            .OrderBy(k => k.HidCode)
            .Select(k => new HidKey(k.HidCode, HidCode.ToHex(k.HidCode), k.Name, k.Category))
            .ToArray();

        return new Keyboard(model.Id, model.Slug, model.Name, model.Vendor, keys);
    }

    /// <summary>Every supported model, flagged with whether this user owns one.</summary>
    public async Task<IReadOnlyList<(Keyboard Keyboard, bool Owned)>> ListKeyboardsAsync(
        string ownerSub, CancellationToken ct = default)
    {
        var models = await db.KeyboardModels
            .AsNoTracking()
            .Include(m => m.Keys)
            .OrderBy(m => m.Id)
            .ToListAsync(ct);

        var ownedIds = await db.UserKeyboards
            .Where(k => k.OwnerSub == ownerSub)
            .Select(k => k.KeyboardModelId)
            .ToListAsync(ct);

        return models
            .Select(m =>
            {
                var keys = m.Keys
                    .OrderBy(k => k.HidCode)
                    .Select(k => new HidKey(k.HidCode, HidCode.ToHex(k.HidCode), k.Name, k.Category))
                    .ToArray();
                return (new Keyboard(m.Id, m.Slug, m.Name, m.Vendor, keys), ownedIds.Contains(m.Id));
            })
            .ToArray();
    }

    /// <summary>
    /// This user's stored overrides. A user who has never written returns an
    /// empty set rather than an error — the honest answer, and it saves the
    /// client a special case.
    /// </summary>
    public async Task<IReadOnlyList<Domain.KeyMapping>> GetMappingsAsync(
        string ownerSub, Keyboard keyboard, CancellationToken ct = default)
    {
        return await db.KeyMappings
            .AsNoTracking()
            .Where(m => m.UserKeyboard!.OwnerSub == ownerSub && m.KeyboardModelId == keyboard.Id)
            .OrderBy(m => m.FromHidCode)
            .Select(m => new Domain.KeyMapping(m.FromHidCode, m.ToHidCode))
            .ToListAsync(ct);
    }

    /// <summary>
    /// Writes the caller's remaps in one transaction.
    ///
    /// <para>
    /// <paramref name="replace"/> false is POST: an incremental upsert that
    /// leaves untouched keys alone. True is PUT: the incoming set becomes the
    /// whole layout and anything absent is cleared.
    /// </para>
    ///
    /// <para>
    /// <paramref name="cleared"/> is the set of keys the request mapped to
    /// themselves. It only affects the POST path: under PUT the incoming set
    /// is the whole layout, so a key absent from it is already cleared.
    /// </para>
    ///
    /// <para>
    /// The user's keyboard is provisioned here on first write, so there is no
    /// separate registration step.
    /// </para>
    /// </summary>
    public async Task ApplyAsync(
        string ownerSub,
        Keyboard keyboard,
        IReadOnlyList<Domain.KeyMapping> incoming,
        IReadOnlyList<int> cleared,
        bool replace,
        CancellationToken ct = default)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);

        var userKeyboard = await GetOrCreateUserKeyboardAsync(ownerSub, keyboard, ct);

        var existing = await db.KeyMappings
            .Where(m => m.UserKeyboardId == userKeyboard.Id)
            .ToListAsync(ct);

        var desired = replace
            ? incoming
            : MappingValidator.Merge(
                existing.Select(m => new Domain.KeyMapping(m.FromHidCode, m.ToHidCode)),
                incoming,
                cleared);

        var desiredByFrom = desired.ToDictionary(m => m.From, m => m.To);
        var now = clock.GetUtcNow();

        foreach (var row in existing)
        {
            if (!desiredByFrom.TryGetValue(row.FromHidCode, out var target))
            {
                db.KeyMappings.Remove(row);
                continue;
            }

            if (row.ToHidCode != target)
            {
                row.ToHidCode = target;
                row.UpdatedAt = now;
            }
            desiredByFrom.Remove(row.FromHidCode);
        }

        // Whatever is left is new.
        foreach (var (from, to) in desiredByFrom)
        {
            db.KeyMappings.Add(new KeyMappingRow
            {
                UserKeyboardId = userKeyboard.Id,
                KeyboardModelId = keyboard.Id,
                FromHidCode = from,
                ToHidCode = to,
                UpdatedAt = now,
            });
        }

        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
    }

    /// <summary>
    /// Clears one remap, or all of them when <paramref name="hidCode"/> is
    /// null. Idempotent: clearing what was never remapped is a success, so a
    /// client retrying after a dropped response sees no spurious error.
    /// </summary>
    public async Task ClearAsync(
        string ownerSub, Keyboard keyboard, int? hidCode, CancellationToken ct = default)
    {
        var userKeyboard = await db.UserKeyboards
            .FirstOrDefaultAsync(k => k.OwnerSub == ownerSub && k.KeyboardModelId == keyboard.Id, ct);

        // Nothing owned means nothing to clear. Provisioning a keyboard just
        // to delete from it would be noise.
        if (userKeyboard is null) return;

        var doomed = db.KeyMappings.Where(m => m.UserKeyboardId == userKeyboard.Id);
        if (hidCode is not null) doomed = doomed.Where(m => m.FromHidCode == hidCode.Value);

        db.KeyMappings.RemoveRange(await doomed.ToListAsync(ct));
        await db.SaveChangesAsync(ct);
    }

    private async Task<UserKeyboard> GetOrCreateUserKeyboardAsync(
        string ownerSub, Keyboard keyboard, CancellationToken ct)
    {
        var existing = await db.UserKeyboards
            .FirstOrDefaultAsync(k => k.OwnerSub == ownerSub && k.KeyboardModelId == keyboard.Id, ct);

        if (existing is not null) return existing;

        var created = new UserKeyboard
        {
            OwnerSub = ownerSub,
            KeyboardModelId = keyboard.Id,
            CreatedAt = clock.GetUtcNow(),
        };

        db.UserKeyboards.Add(created);
        await db.SaveChangesAsync(ct);
        return created;
    }
}
