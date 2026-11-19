using System.Text.Json;

namespace Apex.KeyMapping.Api.Identity;

/// <summary>
/// Resolves who is making the request. Every keyboard is owned, and ownership
/// is never supplied by the client — no route accepts a user identifier, so a
/// caller cannot address another user's data by constructing a URL.
/// </summary>
public interface IOwnerAccessor
{
    /// <summary>
    /// The owner's stable identifier, or null when the caller is not
    /// authenticated. Under Cognito this is the token's <c>sub</c> claim.
    /// </summary>
    string? OwnerSub { get; }
}

/// <summary>
/// Authenticates nobody. Registered outside Development until Cognito lands in
/// roadmap step 5, so a deployed build fails closed: every <c>/api</c> route
/// answers 401 rather than silently trusting the development header.
///
/// <para>
/// The alternative — refusing to start — reads as safer but is worse here. It
/// makes the default environment (Production, when nothing sets one) break
/// <c>dotnet build</c> and <c>dotnet run</c>, which the brief requires to work.
/// Failing every request closed is the same security posture without the
/// collateral damage.
/// </para>
/// </summary>
public sealed class NullOwnerAccessor : IOwnerAccessor
{
    public string? OwnerSub => null;
}

/// <summary>
/// Identity for local development, when no Cognito issuer is configured.
///
/// <para>
/// Resolves the caller in three steps, most explicit first:
/// </para>
/// <list type="number">
///   <item><c>X-Dev-User</c>, for curl and scripted checks</item>
///   <item>the <c>sub</c> claim of a bearer token, <b>decoded without being
///     verified</b></item>
///   <item><see cref="DefaultUser"/>, so "just run it and curl it" works</item>
/// </list>
///
/// <para>
/// Reading the token matters more than it looks. The web client signs in
/// against the real Cognito pool even when pointed at a local API, so without
/// this every signed-in user collapsed onto one owner: you logged in as
/// yourself and saw someone else's layout, per-user isolation could not be
/// exercised locally at all, and switching backends in the client showed
/// different data for each — which reads as the two implementations
/// disagreeing when the only difference was who they thought you were.
/// The serverless dev server already did this; now both match.
/// </para>
///
/// <para>
/// It is still not authentication. Nothing here checks a signature, an issuer
/// or an expiry — any well-formed token is believed. That is only safe because
/// this is registered exclusively when <c>Auth:Authority</c> is unset and the
/// environment is Development; everywhere else
/// <see cref="NullOwnerAccessor"/> fails every request closed.
/// </para>
/// </summary>
public sealed class DevelopmentOwnerAccessor(IHttpContextAccessor accessor) : IOwnerAccessor
{
    /// <summary>Header naming the caller outright, e.g. <c>X-Dev-User: alice</c>.</summary>
    public const string HeaderName = "X-Dev-User";

    /// <summary>Used when neither a header nor a token identifies anyone.</summary>
    public const string DefaultUser = "alice";

    public string? OwnerSub
    {
        get
        {
            var context = accessor.HttpContext;
            if (context is null) return null;

            var header = context.Request.Headers[HeaderName].ToString();
            if (!string.IsNullOrWhiteSpace(header)) return header.Trim();

            return SubjectOf(context.Request.Headers.Authorization.ToString()) ?? DefaultUser;
        }
    }

    /// <summary>
    /// Pulls <c>sub</c> out of a JWT payload. Deliberately does not validate:
    /// the real check happens in the JWT bearer middleware, which is
    /// configured whenever an issuer exists.
    /// </summary>
    private static string? SubjectOf(string? authorization)
    {
        const string prefix = "Bearer ";
        if (authorization is null || !authorization.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var parts = authorization[prefix.Length..].Split('.');
        if (parts.Length < 2) return null;

        try
        {
            // base64url, and JWT omits the padding that Convert requires.
            var payload = parts[1].Replace('-', '+').Replace('_', '/');
            var padded = payload.PadRight(payload.Length + (4 - payload.Length % 4) % 4, '=');

            using var document = JsonDocument.Parse(Convert.FromBase64String(padded));
            return document.RootElement.TryGetProperty("sub", out var sub)
                ? sub.GetString()
                : null;
        }
        catch
        {
            // A malformed token is not an error here — fall through to the
            // default so a bad Authorization header cannot break local work.
            return null;
        }
    }
}
