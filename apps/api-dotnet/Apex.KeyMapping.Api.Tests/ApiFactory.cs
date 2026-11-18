using System.Net.Http.Headers;
using Apex.KeyMapping.Api.Identity;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Apex.KeyMapping.Api.Tests;

/// <summary>
/// Hosts the real application against a throwaway SQLite file.
///
/// <para>
/// A file rather than an in-memory database on purpose: the brief asks for
/// persistence between runs, migrations are what create the schema, and
/// SQLite's in-memory mode behaves differently enough around connection
/// lifetime that it would be testing something other than what ships.
/// </para>
/// </summary>
public sealed class ApiFactory : WebApplicationFactory<Program>
{
    private readonly string _databasePath =
        Path.Combine(Path.GetTempPath(), $"apex-test-{Guid.NewGuid():N}.db");

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        // Development is what registers DevelopmentOwnerAccessor, so tests can
        // act as different users via the header. Cognito replaces this in
        // roadmap step 5 and these tests should keep passing unchanged.
        builder.UseEnvironment("Development");
        builder.UseSetting("ConnectionStrings:Apex", $"Data Source={_databasePath}");
    }

    /// <summary>A client whose requests are attributed to <paramref name="user"/>.</summary>
    public HttpClient CreateClientFor(string user)
    {
        var client = CreateClient();
        client.DefaultRequestHeaders.Add(DevelopmentOwnerAccessor.HeaderName, user);
        return client;
    }

    /// <summary>A client that identifies nobody, to exercise the 401 path.</summary>
    public HttpClient CreateAnonymousClient()
    {
        var client = CreateClient();
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        return client;
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);

        if (!disposing) return;

        // SQLite keeps sidecar files when journalling; clean all of them up.
        foreach (var suffix in new[] { "", "-shm", "-wal" })
        {
            var path = _databasePath + suffix;
            if (File.Exists(path)) File.Delete(path);
        }
    }
}
