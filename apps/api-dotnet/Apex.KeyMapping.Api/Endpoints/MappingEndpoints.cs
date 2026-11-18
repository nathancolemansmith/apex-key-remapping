using System.Text.Json;
using Apex.KeyMapping.Api.Contracts;
using Apex.KeyMapping.Api.Domain;
using Apex.KeyMapping.Api.Identity;
using Apex.KeyMapping.Api.Services;

namespace Apex.KeyMapping.Api.Endpoints;

/// <summary>
/// The seven operations defined by packages/api-contract/openapi.yaml.
///
/// Every handler follows the same shape: resolve the owner from the request
/// context, resolve the keyboard from the route, then act. The owner is never
/// read from the body or the URL, which is what makes cross-user access
/// unreachable rather than merely unimplemented.
/// </summary>
public static class MappingEndpoints
{
    public static void MapMappingEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/health", () => Results.Ok(new { status = "healthy" }))
            .WithName("getHealth")
            .WithSummary("Liveness probe.")
            .AllowAnonymous();

        var api = app.MapGroup("/api/keyboards");

        api.MapGet("/", ListKeyboards)
            .WithName("listKeyboards")
            .WithSummary("List supported keyboard models.");

        api.MapGet("/{keyboard}/mappings", GetMappings)
            .WithName("getMappings")
            .WithSummary("Get the caller's full key layout.");

        api.MapPost("/{keyboard}/mappings", AddMappings)
            .WithName("addMappings")
            .WithSummary("Add remappings, leaving existing ones in place.");

        api.MapPut("/{keyboard}/mappings", ReplaceMappings)
            .WithName("replaceMappings")
            .WithSummary("Replace the caller's entire remap set.");

        api.MapDelete("/{keyboard}/mappings/{hidCode}", ClearMapping)
            .WithName("clearMapping")
            .WithSummary("Clear one key's remap.");

        api.MapDelete("/{keyboard}/mappings", ClearAllMappings)
            .WithName("clearAllMappings")
            .WithSummary("Clear all of the caller's remaps for this keyboard.");
    }

    private static async Task<IResult> ListKeyboards(
        IOwnerAccessor owner, KeyboardService service, CancellationToken ct)
    {
        if (owner.OwnerSub is not { } ownerSub) return ApiProblem.Unauthorized();

        var keyboards = await service.ListKeyboardsAsync(ownerSub, ct);

        return Results.Ok(new KeyboardListResponse(
            keyboards
                .Select(k => new KeyboardSummary(
                    k.Keyboard.Slug, k.Keyboard.Name, k.Keyboard.Vendor, k.Keyboard.Keys.Count, k.Owned))
                .ToArray()));
    }

    private static async Task<IResult> GetMappings(
        string keyboard, IOwnerAccessor owner, KeyboardService service, CancellationToken ct)
    {
        if (owner.OwnerSub is not { } ownerSub) return ApiProblem.Unauthorized();

        var model = await service.FindKeyboardAsync(keyboard, ct);
        if (model is null) return ApiProblem.UnknownKeyboard(keyboard);

        var mappings = await service.GetMappingsAsync(ownerSub, model, ct);
        return Results.Ok(KeyboardMappingsResponse.Build(model, mappings));
    }

    private static Task<IResult> AddMappings(
        string keyboard, JsonElement body, IOwnerAccessor owner, KeyboardService service, CancellationToken ct) =>
        Write(keyboard, body, owner, service, replace: false, ct);

    private static Task<IResult> ReplaceMappings(
        string keyboard, JsonElement body, IOwnerAccessor owner, KeyboardService service, CancellationToken ct) =>
        Write(keyboard, body, owner, service, replace: true, ct);

    /// <summary>
    /// POST and PUT differ only in whether absent keys are cleared, so they
    /// share everything up to that flag. Both return 204: the brief asks for
    /// no response body beyond an indication of success or failure.
    /// </summary>
    private static async Task<IResult> Write(
        string keyboard,
        JsonElement body,
        IOwnerAccessor owner,
        KeyboardService service,
        bool replace,
        CancellationToken ct)
    {
        if (owner.OwnerSub is not { } ownerSub) return ApiProblem.Unauthorized();

        var model = await service.FindKeyboardAsync(keyboard, ct);
        if (model is null) return ApiProblem.UnknownKeyboard(keyboard);

        if (body.ValueKind != JsonValueKind.Object || !body.TryGetProperty("mappings", out var mappings))
        {
            return ApiProblem.MalformedBody("`mappings` must be an array.");
        }

        var result = MappingValidator.Validate(model, mappings);
        if (!result.Ok) return ApiProblem.ValidationFailed(result.Errors);

        await service.ApplyAsync(ownerSub, model, result.Mappings, result.Cleared, replace, ct);
        return Results.NoContent();
    }

    private static async Task<IResult> ClearMapping(
        string keyboard, string hidCode, IOwnerAccessor owner, KeyboardService service, CancellationToken ct)
    {
        if (owner.OwnerSub is not { } ownerSub) return ApiProblem.Unauthorized();

        var model = await service.FindKeyboardAsync(keyboard, ct);
        if (model is null) return ApiProblem.UnknownKeyboard(keyboard);

        // A code that is not a key on this keyboard is a malformed request
        // rather than a missing resource, so it is a 400 and not a 404.
        var parsed = HidCode.Parse(hidCode);
        if (parsed is null || !model.HasKey(parsed.Value))
        {
            return ApiProblem.ValidationFailed([
                new ValidationError(-1, "from", parsed is null
                    ? $"\"{hidCode}\" is not a valid 8-bit HID code (expected 0–255 or 0x00–0xFF)."
                    : $"{HidCode.ToHex(parsed.Value)} is not a key on {model.Name}."),
            ]);
        }

        await service.ClearAsync(ownerSub, model, parsed.Value, ct);
        return Results.NoContent();
    }

    private static async Task<IResult> ClearAllMappings(
        string keyboard, IOwnerAccessor owner, KeyboardService service, CancellationToken ct)
    {
        if (owner.OwnerSub is not { } ownerSub) return ApiProblem.Unauthorized();

        var model = await service.FindKeyboardAsync(keyboard, ct);
        if (model is null) return ApiProblem.UnknownKeyboard(keyboard);

        await service.ClearAsync(ownerSub, model, hidCode: null, ct);
        return Results.NoContent();
    }
}
