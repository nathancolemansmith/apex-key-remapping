using System.Security.Claims;

namespace Apex.KeyMapping.Api.Identity;

/// <summary>
/// Resolves the owner from a validated Cognito access token.
///
/// <para>
/// By the time this runs the token has already been checked by the JWT bearer
/// middleware — signature against the pool's JWKS, issuer, expiry. This only
/// reads the result, which is why it is this small.
/// </para>
///
/// <para>
/// The <c>sub</c> claim is the owner. It is a stable pool-scoped UUID that
/// does not change when a user edits their email or username, which is exactly
/// what a database key needs. Using the username here would silently orphan
/// someone's keyboards the first time they renamed themselves.
/// </para>
/// </summary>
public sealed class JwtOwnerAccessor(IHttpContextAccessor accessor) : IOwnerAccessor
{
    public string? OwnerSub
    {
        get
        {
            var user = accessor.HttpContext?.User;
            if (user?.Identity?.IsAuthenticated != true) return null;

            // ASP.NET Core maps `sub` to ClaimTypes.NameIdentifier by default,
            // so check both rather than depending on whether that mapping is
            // turned on.
            var sub = user.FindFirstValue("sub") ?? user.FindFirstValue(ClaimTypes.NameIdentifier);

            return string.IsNullOrWhiteSpace(sub) ? null : sub;
        }
    }
}
