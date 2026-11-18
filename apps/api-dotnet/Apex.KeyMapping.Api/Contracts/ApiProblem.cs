using System.Text.Json.Serialization;
using Apex.KeyMapping.Api.Domain;

namespace Apex.KeyMapping.Api.Contracts;

/// <summary>
/// RFC 9457 problem details, shaped to match packages/api-contract/openapi.yaml
/// field for field. The serverless implementation returns the same JSON, so a
/// client can handle errors identically regardless of which backend answered.
/// </summary>
public sealed record ApiProblem(
    string Type,
    string Title,
    int Status,
    string Detail,
    // Omitted entirely rather than serialized as null. The contract declares
    // `errors` as an array present only on validation failures, so emitting
    // `"errors": null` on a 404 both violates the schema and would diverge
    // from the serverless implementation, which has no null to emit.
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    IReadOnlyList<ValidationError>? Errors = null)
{
    private const string Rfc = "https://www.rfc-editor.org/rfc/rfc9457";

    private static IResult Respond(ApiProblem problem) =>
        Results.Json(problem, statusCode: problem.Status, contentType: "application/problem+json");

    public static IResult Unauthorized() => Respond(new ApiProblem(
        Rfc, "Unauthorized", StatusCodes.Status401Unauthorized,
        "A valid bearer token is required."));

    public static IResult UnknownKeyboard(string identifier) => Respond(new ApiProblem(
        Rfc, "Not Found", StatusCodes.Status404NotFound,
        $"'{identifier}' is not a supported keyboard."));

    /// <summary>
    /// Every failure at once, never just the first. A client fixing a batch of
    /// mappings should not have to round-trip once per mistake.
    /// </summary>
    public static IResult ValidationFailed(IReadOnlyList<ValidationError> errors) => Respond(new ApiProblem(
        Rfc, "Invalid key mappings", StatusCodes.Status400BadRequest,
        $"The request contained {errors.Count} invalid mapping{(errors.Count == 1 ? "" : "s")}.",
        errors));

    public static IResult MalformedBody(string detail) => Respond(new ApiProblem(
        Rfc, "Invalid key mappings", StatusCodes.Status400BadRequest, detail,
        [new ValidationError(-1, "mappings", detail)]));
}
