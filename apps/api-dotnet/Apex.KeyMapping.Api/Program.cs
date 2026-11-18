using Apex.KeyMapping.Api.Data;
using Apex.KeyMapping.Api.Endpoints;
using Apex.KeyMapping.Api.Identity;
using Apex.KeyMapping.Api.Services;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;

var builder = WebApplication.CreateBuilder(args);

// The brief asks for SQLite that persists between runs, so the default is a
// file beside the application rather than an in-memory database. Tests
// override this with their own connection string.
var connectionString = builder.Configuration.GetConnectionString("Apex")
    ?? $"Data Source={Path.Combine(builder.Environment.ContentRootPath, "apex.db")}";

builder.Services.AddDbContext<ApexDbContext>(options => options.UseSqlite(connectionString));

builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddScoped<KeyboardService>();
builder.Services.AddHttpContextAccessor();

// Identity is resolved through IOwnerAccessor, so which of these is
// registered is the only thing that changes between a laptop and ECS. No
// endpoint knows the difference.
//
// `Auth:Authority` is the Cognito issuer. When it is configured the real
// thing runs; when it is not, Development falls back to a trusted header and
// anything else fails closed.
var authority = builder.Configuration["Auth:Authority"];
var jwtConfigured = !string.IsNullOrWhiteSpace(authority);

if (jwtConfigured)
{
    builder.Services
        .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
        .AddJwtBearer(options =>
        {
            // JwtBearer discovers the signing keys from
            // {authority}/.well-known/openid-configuration and refreshes them
            // on rotation, so no key material is deployed with the app.
            options.Authority = authority;

            options.TokenValidationParameters = new TokenValidationParameters
            {
                ValidateIssuer = true,
                ValidIssuer = authority,
                ValidateIssuerSigningKey = true,
                ValidateLifetime = true,
                ClockSkew = TimeSpan.FromSeconds(30),

                // Cognito *access* tokens carry no `aud` claim — the audience
                // is in `client_id` instead. Validating audience here would
                // reject every real token, so it is checked explicitly below.
                ValidateAudience = false,
            };

            var clientId = builder.Configuration["Auth:ClientId"];
            options.Events = new JwtBearerEvents
            {
                OnTokenValidated = context =>
                {
                    var principal = context.Principal;

                    // Reject ID tokens. Both are signed by the same pool, so
                    // without this check an ID token would authenticate
                    // against an API it was never issued for.
                    if (principal?.FindFirst("token_use")?.Value != "access")
                    {
                        context.Fail("Expected an access token.");
                        return Task.CompletedTask;
                    }

                    // The audience check that ValidateAudience cannot do.
                    if (!string.IsNullOrWhiteSpace(clientId)
                        && principal.FindFirst("client_id")?.Value != clientId)
                    {
                        context.Fail("Token was issued for a different client.");
                    }

                    return Task.CompletedTask;
                },
            };
        });

    builder.Services.AddAuthorization();
    builder.Services.AddScoped<IOwnerAccessor, JwtOwnerAccessor>();
}
else if (builder.Environment.IsDevelopment())
{
    // Not authentication — it trusts a header outright. It exists so the
    // shape of the flow is real while running locally without AWS.
    builder.Services.AddScoped<IOwnerAccessor, DevelopmentOwnerAccessor>();
}
else
{
    // Fail closed. No issuer configured outside Development means nobody is
    // authenticated and every /api route answers 401.
    builder.Services.AddScoped<IOwnerAccessor, NullOwnerAccessor>();
}

// Generates the OpenAPI document that CI diffs against the canonical contract.
builder.Services.AddOpenApi();

var app = builder.Build();

// Migrations are applied on startup so the first run creates apex.db, seeds
// the 92 keys, and the database then persists between runs — no separate
// setup step for someone running this locally.
await using (var scope = app.Services.CreateAsyncScope())
{
    var db = scope.ServiceProvider.GetRequiredService<ApexDbContext>();
    await db.Database.MigrateAsync();
}

// Only when a scheme is registered — calling these with no authentication
// configured throws at startup, and the no-auth paths deliberately have none.
if (jwtConfigured)
{
    app.UseAuthentication();
    app.UseAuthorization();
}

app.MapOpenApi();
app.MapMappingEndpoints();

// The generated Program class is public in .NET 10, so the integration tests
// can drive the real application without the old partial-class declaration.
await app.RunAsync();
