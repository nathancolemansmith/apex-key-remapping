using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Apex.KeyMapping.Api.Tests;

/// <summary>
/// Drives the real application over HTTP, against a real migrated SQLite
/// database. These assert the contract in packages/api-contract/openapi.yaml
/// from the outside, which is the level the serverless implementation will
/// have to satisfy too.
/// </summary>
public sealed class MappingApiTests : IClassFixture<ApiFactory>
{
    private const string Keyboard = "apex-pro-gen-3";
    private const string Route = $"/api/keyboards/{Keyboard}/mappings";

    // From the brief: "A (0x04)" should remap to "Z (0x1D)".
    private const int A = 0x04;
    private const int Z = 0x1D;
    private const int B = 0x05;
    private const int C = 0x06;
    private const int CapsLock = 0x39;
    private const int LeftCtrl = 0xE0;

    // A valid 8-bit HID code that is deliberately not a key on this keyboard.
    private const int NotAKey = 0x64;

    private readonly ApiFactory _factory;

    public MappingApiTests(ApiFactory factory) => _factory = factory;

    private static HttpContent Mappings(params (int From, int To)[] mappings) =>
        JsonContent.Create(new { mappings = mappings.Select(m => new { from = m.From, to = m.To }) });

    private static async Task<JsonElement> ReadJson(HttpResponseMessage response) =>
        JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;

    /// <summary>A fresh user, so each test starts from an empty layout.</summary>
    private HttpClient NewUser([System.Runtime.CompilerServices.CallerMemberName] string name = "") =>
        _factory.CreateClientFor($"{name}-{Guid.NewGuid():N}");

    [Fact]
    public async Task Health_is_public()
    {
        var response = await _factory.CreateAnonymousClient().GetAsync("/health");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("healthy", (await ReadJson(response)).GetProperty("status").GetString());
    }

    [Fact]
    public async Task Unremapped_keyboard_returns_every_key_mapped_to_itself()
    {
        var response = await NewUser().GetAsync(Route);
        var body = await ReadJson(response);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("Apex Pro Gen 3", body.GetProperty("keyboard").GetString());
        Assert.Equal(92, body.GetProperty("totalKeys").GetInt32());
        Assert.Equal(0, body.GetProperty("remappedCount").GetInt32());

        var keys = body.GetProperty("keys").EnumerateArray().ToArray();
        Assert.Equal(92, keys.Length);
        Assert.All(keys, key =>
        {
            Assert.False(key.GetProperty("isRemapped").GetBoolean());
            Assert.Equal(
                key.GetProperty("hidCode").GetInt32(),
                key.GetProperty("mappedTo").GetProperty("hidCode").GetInt32());
        });
    }

    [Fact]
    public async Task Keys_are_returned_in_hid_code_order()
    {
        var body = await ReadJson(await NewUser().GetAsync(Route));

        var codes = body.GetProperty("keys").EnumerateArray()
            .Select(k => k.GetProperty("hidCode").GetInt32())
            .ToArray();

        Assert.Equal(codes.OrderBy(c => c).ToArray(), codes);
    }

    [Fact]
    public async Task The_briefs_own_example_round_trips()
    {
        var client = NewUser();

        // "A (0x04)" -> "Z (0x1D)", and "4 (0x21)" -> "2 (0x1F)".
        var write = await client.PostAsync(Route, Mappings((A, Z), (0x21, 0x1F)));
        Assert.Equal(HttpStatusCode.NoContent, write.StatusCode);

        var body = await ReadJson(await client.GetAsync(Route));
        Assert.Equal(2, body.GetProperty("remappedCount").GetInt32());

        var a = body.GetProperty("keys").EnumerateArray()
            .Single(k => k.GetProperty("hidCode").GetInt32() == A);

        Assert.True(a.GetProperty("isRemapped").GetBoolean());
        Assert.Equal("A", a.GetProperty("name").GetString());
        Assert.Equal(Z, a.GetProperty("mappedTo").GetProperty("hidCode").GetInt32());
        Assert.Equal("Z", a.GetProperty("mappedTo").GetProperty("name").GetString());
        Assert.Equal("0x1D", a.GetProperty("mappedTo").GetProperty("hidCodeHex").GetString());

        // Remapping A to Z does not change what Z itself does.
        var z = body.GetProperty("keys").EnumerateArray()
            .Single(k => k.GetProperty("hidCode").GetInt32() == Z);
        Assert.False(z.GetProperty("isRemapped").GetBoolean());
    }

    [Fact]
    public async Task Hid_codes_are_accepted_as_decimal_or_hex()
    {
        var client = NewUser();

        var response = await client.PostAsync(Route, JsonContent.Create(new
        {
            mappings = new object[]
            {
                new { from = "0x04", to = "0x1D" },   // prefixed hex
                new { from = 5, to = 6 },             // decimal integers
                new { from = "57", to = "224" },      // decimal strings
            },
        }));

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);

        var body = await ReadJson(await client.GetAsync(Route));
        Assert.Equal(3, body.GetProperty("remappedCount").GetInt32());
    }

    [Fact]
    public async Task Post_adds_incrementally_and_leaves_other_keys_alone()
    {
        var client = NewUser();

        await client.PostAsync(Route, Mappings((A, Z)));
        await client.PostAsync(Route, Mappings((CapsLock, LeftCtrl)));

        var body = await ReadJson(await client.GetAsync(Route));
        Assert.Equal(2, body.GetProperty("remappedCount").GetInt32());
    }

    [Fact]
    public async Task Post_to_an_already_remapped_key_updates_rather_than_conflicting()
    {
        var client = NewUser();

        await client.PostAsync(Route, Mappings((A, Z)));
        var second = await client.PostAsync(Route, Mappings((A, C)));

        Assert.Equal(HttpStatusCode.NoContent, second.StatusCode);

        var body = await ReadJson(await client.GetAsync(Route));
        Assert.Equal(1, body.GetProperty("remappedCount").GetInt32());

        var a = body.GetProperty("keys").EnumerateArray()
            .Single(k => k.GetProperty("hidCode").GetInt32() == A);
        Assert.Equal(C, a.GetProperty("mappedTo").GetProperty("hidCode").GetInt32());
    }

    [Fact]
    public async Task Put_replaces_the_whole_set_and_is_idempotent()
    {
        var client = NewUser();

        await client.PostAsync(Route, Mappings((A, Z), (B, C)));
        await client.PutAsync(Route, Mappings((CapsLock, LeftCtrl)));

        var afterFirst = await ReadJson(await client.GetAsync(Route));
        Assert.Equal(1, afterFirst.GetProperty("remappedCount").GetInt32());

        // Same request again leaves the same state.
        await client.PutAsync(Route, Mappings((CapsLock, LeftCtrl)));
        var afterSecond = await ReadJson(await client.GetAsync(Route));
        Assert.Equal(1, afterSecond.GetProperty("remappedCount").GetInt32());
    }

    [Fact]
    public async Task Put_with_an_empty_list_clears_everything()
    {
        var client = NewUser();

        await client.PostAsync(Route, Mappings((A, Z), (B, C)));
        await client.PutAsync(Route, Mappings());

        var body = await ReadJson(await client.GetAsync(Route));
        Assert.Equal(0, body.GetProperty("remappedCount").GetInt32());
    }

    /// <summary>
    /// Regression. Validation strips identity mappings before merge ever sees
    /// them, so this path was silently a no-op while both halves passed their
    /// own unit tests. The README and the OpenAPI `clearOne` example both
    /// promise it clears the override.
    /// </summary>
    [Fact]
    public async Task Mapping_a_key_to_itself_clears_that_override()
    {
        var client = NewUser();

        await client.PostAsync(Route, Mappings((A, Z), (B, C)));
        await client.PostAsync(Route, Mappings((A, A)));

        var body = await ReadJson(await client.GetAsync(Route));

        Assert.Equal(1, body.GetProperty("remappedCount").GetInt32());

        var remaining = body.GetProperty("keys").EnumerateArray()
            .Where(k => k.GetProperty("isRemapped").GetBoolean())
            .Select(k => k.GetProperty("hidCode").GetInt32())
            .ToArray();

        Assert.Equal([B], remaining);
    }

    [Fact]
    public async Task A_request_can_clear_one_key_and_add_another()
    {
        var client = NewUser();

        await client.PostAsync(Route, Mappings((A, Z)));
        await client.PostAsync(Route, Mappings((A, A), (B, C)));

        var body = await ReadJson(await client.GetAsync(Route));
        var remaining = body.GetProperty("keys").EnumerateArray()
            .Where(k => k.GetProperty("isRemapped").GetBoolean())
            .Select(k => k.GetProperty("hidCode").GetInt32())
            .ToArray();

        Assert.Equal([B], remaining);
    }

    [Fact]
    public async Task Two_keys_may_target_the_same_key()
    {
        var client = NewUser();

        // Legitimate: a real keyboard can have two keys that both emit Z.
        var response = await client.PostAsync(Route, Mappings((A, Z), (B, Z)));

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);

        var body = await ReadJson(await client.GetAsync(Route));
        Assert.Equal(2, body.GetProperty("remappedCount").GetInt32());
    }

    [Fact]
    public async Task Delete_clears_one_key_and_is_idempotent()
    {
        var client = NewUser();

        await client.PostAsync(Route, Mappings((A, Z), (B, C)));

        var first = await client.DeleteAsync($"{Route}/0x04");
        var second = await client.DeleteAsync($"{Route}/0x04");

        Assert.Equal(HttpStatusCode.NoContent, first.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, second.StatusCode);

        var body = await ReadJson(await client.GetAsync(Route));
        Assert.Equal(1, body.GetProperty("remappedCount").GetInt32());
    }

    [Fact]
    public async Task Delete_all_clears_everything_and_is_idempotent()
    {
        var client = NewUser();

        await client.PostAsync(Route, Mappings((A, Z), (B, C)));

        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync(Route)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync(Route)).StatusCode);

        var body = await ReadJson(await client.GetAsync(Route));
        Assert.Equal(0, body.GetProperty("remappedCount").GetInt32());
    }

    [Fact]
    public async Task Validation_failures_report_every_problem_at_once()
    {
        var client = NewUser();

        var response = await client.PostAsync(Route, Mappings(
            (A, NotAKey),   // 0x64 is a real HID code but not a key here
            (B, C),
            (B, 0x07)));    // B used twice as a source

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);

        var errors = (await ReadJson(response)).GetProperty("errors").EnumerateArray().ToArray();

        Assert.Equal(2, errors.Length);
        Assert.Equal("to", errors[0].GetProperty("field").GetString());
        Assert.Contains("not a key on", errors[0].GetProperty("message").GetString());
        Assert.Equal("from", errors[1].GetProperty("field").GetString());
        Assert.Contains("remapped more than once", errors[1].GetProperty("message").GetString());
    }

    [Fact]
    public async Task A_rejected_request_changes_nothing()
    {
        var client = NewUser();

        await client.PostAsync(Route, Mappings((A, Z)));
        await client.PostAsync(Route, Mappings((B, NotAKey)));

        var body = await ReadJson(await client.GetAsync(Route));
        Assert.Equal(1, body.GetProperty("remappedCount").GetInt32());
    }

    /// <summary>
    /// Regression, found by the Postman collection on its first run. The
    /// contract declares `errors` as an array present only on validation
    /// failures, so serializing it as null on a 404 violated the schema and
    /// would have diverged from the serverless implementation, which has no
    /// null to emit.
    /// </summary>
    [Fact]
    public async Task Problem_details_omit_errors_when_there_are_none()
    {
        var client = NewUser();

        var notFound = await client.GetAsync("/api/keyboards/model-m/mappings");
        var body = await ReadJson(notFound);

        Assert.Equal(HttpStatusCode.NotFound, notFound.StatusCode);
        Assert.Equal("application/problem+json", notFound.Content.Headers.ContentType?.MediaType);

        Assert.False(
            body.TryGetProperty("errors", out _),
            "`errors` should be absent, not null, when there are no field errors.");

        var names = body.EnumerateObject().Select(p => p.Name).Order().ToArray();
        Assert.Equal(["detail", "status", "title", "type"], names);
    }

    [Fact]
    public async Task Keyboard_resolves_by_slug_or_display_name()
    {
        var client = NewUser();

        var bySlug = await client.GetAsync("/api/keyboards/apex-pro-gen-3/mappings");
        var byName = await client.GetAsync("/api/keyboards/Apex%20Pro%20Gen%203/mappings");
        var byLowerName = await client.GetAsync("/api/keyboards/apex%20pro%20gen%203/mappings");

        foreach (var response in new[] { bySlug, byName, byLowerName })
        {
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal("apex-pro-gen-3", (await ReadJson(response)).GetProperty("keyboardSlug").GetString());
        }
    }

    /// <summary>
    /// The claim the whole ownership model exists to support: same database,
    /// same keyboard, different answers. Identity comes from the request
    /// context and no route accepts a user, so there is no way to ask for
    /// someone else's layout.
    /// </summary>
    [Fact]
    public async Task One_users_remaps_are_invisible_to_another()
    {
        var alice = NewUser();
        var bob = NewUser();

        await alice.PostAsync(Route, Mappings((CapsLock, LeftCtrl)));

        var aliceView = await ReadJson(await alice.GetAsync(Route));
        var bobView = await ReadJson(await bob.GetAsync(Route));

        Assert.Equal(1, aliceView.GetProperty("remappedCount").GetInt32());
        Assert.Equal(0, bobView.GetProperty("remappedCount").GetInt32());

        // Bob still gets the full keyboard, just with nothing remapped.
        Assert.Equal(92, bobView.GetProperty("totalKeys").GetInt32());

        // And bob writing does not disturb alice.
        await bob.PostAsync(Route, Mappings((A, Z)));
        var aliceAfter = await ReadJson(await alice.GetAsync(Route));

        var aliceRemapped = aliceAfter.GetProperty("keys").EnumerateArray()
            .Where(k => k.GetProperty("isRemapped").GetBoolean())
            .Select(k => k.GetProperty("hidCode").GetInt32())
            .ToArray();

        Assert.Equal([CapsLock], aliceRemapped);
    }

    [Fact]
    public async Task Deleting_one_users_mappings_leaves_anothers_alone()
    {
        var alice = NewUser();
        var bob = NewUser();

        await alice.PostAsync(Route, Mappings((A, Z)));
        await bob.PostAsync(Route, Mappings((A, Z)));

        await alice.DeleteAsync(Route);

        Assert.Equal(0, (await ReadJson(await alice.GetAsync(Route))).GetProperty("remappedCount").GetInt32());
        Assert.Equal(1, (await ReadJson(await bob.GetAsync(Route))).GetProperty("remappedCount").GetInt32());
    }

    [Fact]
    public async Task Listing_keyboards_reports_ownership_per_user()
    {
        var owner = NewUser();
        var stranger = NewUser();

        await owner.PostAsync(Route, Mappings((A, Z)));

        var ownerView = await ReadJson(await owner.GetAsync("/api/keyboards"));
        var strangerView = await ReadJson(await stranger.GetAsync("/api/keyboards"));

        Assert.True(ownerView.GetProperty("keyboards")[0].GetProperty("owned").GetBoolean());
        Assert.False(strangerView.GetProperty("keyboards")[0].GetProperty("owned").GetBoolean());
        Assert.Equal(92, ownerView.GetProperty("keyboards")[0].GetProperty("totalKeys").GetInt32());
    }
}
