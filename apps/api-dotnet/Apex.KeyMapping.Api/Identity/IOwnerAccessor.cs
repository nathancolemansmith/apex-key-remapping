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
/// Development stand-in used until Cognito lands.
///
/// <para>
/// This exists to keep the <em>shape</em> of authentication real while the
/// real thing is still unbuilt: endpoints already resolve identity through
/// this interface and already return 401 when it yields nothing, so swapping
/// in JWT validation changes registration and nothing else.
/// </para>
///
/// <para>
/// It is not authentication and does not pretend to be — it trusts a header
/// outright. <see cref="DevelopmentOwnerAccessor"/> is only ever registered
/// outside Production, and <c>Program.cs</c> refuses to start if that is
/// violated.
/// </para>
/// </summary>
public sealed class DevelopmentOwnerAccessor(IHttpContextAccessor accessor) : IOwnerAccessor
{
    /// <summary>Header carrying the pretend user, e.g. <c>X-Dev-User: alice</c>.</summary>
    public const string HeaderName = "X-Dev-User";

    /// <summary>
    /// Used when no header is supplied, so the brief's "just run it and curl
    /// it" path works without ceremony. Per-user isolation is demonstrable by
    /// sending the header explicitly.
    /// </summary>
    public const string DefaultUser = "alice";

    public string? OwnerSub
    {
        get
        {
            var context = accessor.HttpContext;
            if (context is null) return null;

            var header = context.Request.Headers[HeaderName].ToString();
            return string.IsNullOrWhiteSpace(header) ? DefaultUser : header.Trim();
        }
    }
}
