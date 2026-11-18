using Apex.KeyMapping.Api.Data;
using Apex.KeyMapping.Api.Endpoints;
using Apex.KeyMapping.Api.Identity;
using Apex.KeyMapping.Api.Services;
using Microsoft.EntityFrameworkCore;

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

// Identity is resolved through IOwnerAccessor so that adding Cognito is a
// registration change rather than an endpoint change. The development
// accessor trusts a header outright, which is emphatically not
// authentication, so only a non-deployed environment gets it. Anywhere else
// fails closed: NullOwnerAccessor authenticates nobody and every /api route
// answers 401 until roadmap step 5 wires up real JWT validation.
if (builder.Environment.IsDevelopment())
{
    builder.Services.AddScoped<IOwnerAccessor, DevelopmentOwnerAccessor>();
}
else
{
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

app.MapOpenApi();
app.MapMappingEndpoints();

// The generated Program class is public in .NET 10, so the integration tests
// can drive the real application without the old partial-class declaration.
await app.RunAsync();
