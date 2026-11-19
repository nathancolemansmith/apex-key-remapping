# Apex Key Remapping

A key remapping service for the **SteelSeries Apex Pro Gen 3**, built from the
brief in [KeyboardBindingsProblem.md](KeyboardBindingsProblem.md).

The service validates and stores remappings between physical keys (identified
by [USB HID usage codes](HidKeyCodes.md)) and returns the full effective layout
for a keyboard. Keyboards are owned by users, authenticated with AWS Cognito,
so each user's layout is private to them.

The same API is implemented **twice** against one shared domain contract:

| Implementation | Stack | Persistence | Hosting | Token validated by |
|---|---|---|---|---|
| [`apps/api-dotnet`](apps/api-dotnet) | ASP.NET Core 10 Minimal API | SQLite via EF Core migrations | ECS Fargate + ALB | JWT bearer middleware |
| [`apps/api-serverless`](apps/api-serverless) | TypeScript, AWS Lambda | DynamoDB | API Gateway + Lambda | API Gateway JWT authorizer |

Both are deployed, and the same Postman collection passes **38 assertions
against each**. Identical requests return byte-identical responses — verified
by diffing them, not asserted.

A React client in [`apps/web`](apps/web) exercises either backend so the two can
be compared side by side against identical requests.

> **Status:** the .NET API and the React client are **built, tested and
> deployed**. The API runs on ECS Fargate behind an ALB, authenticates against
> a real Cognito user pool, and keeps its SQLite database on EFS so it
> survives container replacement. The client is served from S3 through
> CloudFront, which also fronts the API so both share one origin. Both
> redeploy from GitHub Actions on push to `main`. The serverless
> implementation is deployed too, and both answer the same contract —
> see [Roadmap](#roadmap).

---

## Why two implementations

The brief asks for C# or Go with SQLite. That is the primary deliverable, so
[`apps/api-dotnet`](apps/api-dotnet) follows it literally — ASP.NET Core with a
SQLite file that persists between runs.

The serverless implementation is a deliberate second take, included to show the
same domain modelled under different constraints. It swaps SQLite for DynamoDB,
because a Lambda's filesystem is ephemeral and a SQLite file in `/tmp` does not
survive cold starts or scale past one concurrent writer. Keeping SQLite there
would have meant EFS plus a VPC — real complexity bought for no benefit at this
data size.

Auth diverges the same way: the .NET app validates tokens in middleware, while
the serverless stack pushes validation out to an API Gateway authorizer that
rejects bad tokens before any code runs. Those tradeoffs — where state lives,
where trust is established — are the point of having both.

## Repository layout

```
.
├── packages/api-contract/     Canonical OpenAPI document both backends answer to
├── packages/hid-catalog/      Shared remapping domain rules + seed generation
├── apps/api-dotnet/           ASP.NET Core 10 + SQLite implementation
├── apps/api-serverless/       TypeScript Lambda + DynamoDB implementation
├── apps/web/                  React client for both APIs
├── infra/                     AWS CDK stacks (Cognito, ECS, Lambda, hosting)
└── .github/workflows/         Build, test and deploy pipeline
```

[REPOSITORY.md](REPOSITORY.md) covers the monorepo in detail — what belongs in
each directory, how the npm workspace is wired, where the .NET project sits
outside it, and diagrams of the catalog generation and request flows.
[apps/api-dotnet/REPOSITORY.md](apps/api-dotnet/REPOSITORY.md) does the same
for the .NET project, written to be readable without prior .NET experience.

## Data model

The keyboard and its keys are **rows in the database**, not a JSON blob
compiled into the application. An EF Core migration creates the schema and
seeds the catalog; from then on the database is the authoritative source of
what keys exist, and the API reads it like any other data.

Ownership splits the model in two. *"An Apex Pro Gen 3 has these 92 keys"* is a
product fact, true for everyone, and it is what the migration seeds. *"I have
remapped Caps Lock to Left Ctrl"* belongs to one user. So the model a keyboard
is becomes separate from the keyboard a user owns:

```sql
-- ── Product catalog: seeded by migration, shared by every user ──────────────
CREATE TABLE KeyboardModels (
    Id      INTEGER PRIMARY KEY,
    Slug    TEXT NOT NULL UNIQUE,          -- apex-pro-gen-3
    Name    TEXT NOT NULL,                 -- Apex Pro Gen 3
    Vendor  TEXT NOT NULL
);

CREATE TABLE Keys (
    KeyboardModelId INTEGER NOT NULL REFERENCES KeyboardModels(Id) ON DELETE CASCADE,
    HidCode         INTEGER NOT NULL CHECK (HidCode BETWEEN 0 AND 255),
    Name            TEXT NOT NULL,         -- A, Caps Lock, Numpad 7
    Category        TEXT NOT NULL,         -- Letters, Modifiers, Numpad, ...
    PRIMARY KEY (KeyboardModelId, HidCode)
);

-- ── User-owned data ────────────────────────────────────────────────────────
-- One row per keyboard a user owns, created on that user's first write.
CREATE TABLE UserKeyboards (
    Id              INTEGER PRIMARY KEY,
    OwnerSub        TEXT NOT NULL,         -- Cognito `sub` claim
    KeyboardModelId INTEGER NOT NULL REFERENCES KeyboardModels(Id),
    CreatedAt       TEXT NOT NULL,

    UNIQUE (OwnerSub, KeyboardModelId),    -- one Apex Pro Gen 3 per user
    UNIQUE (Id, KeyboardModelId)           -- lets KeyMappings pin the model
);

CREATE TABLE KeyMappings (
    UserKeyboardId  INTEGER NOT NULL,
    KeyboardModelId INTEGER NOT NULL,
    FromHidCode     INTEGER NOT NULL,
    ToHidCode       INTEGER NOT NULL,
    UpdatedAt       TEXT NOT NULL,

    -- One remap per physical key, per owned keyboard.
    PRIMARY KEY (UserKeyboardId, FromHidCode),

    -- The model must be the one this user's keyboard actually is...
    FOREIGN KEY (UserKeyboardId, KeyboardModelId)
        REFERENCES UserKeyboards(Id, KeyboardModelId) ON DELETE CASCADE,

    -- ...and both ends must be real keys on that model.
    FOREIGN KEY (KeyboardModelId, FromHidCode) REFERENCES Keys(KeyboardModelId, HidCode),
    FOREIGN KEY (KeyboardModelId, ToHidCode)   REFERENCES Keys(KeyboardModelId, HidCode)
);
```

Keeping the catalog in tables lets the schema enforce the rules rather than
leaving them to application code:

- `FromHidCode` and `ToHidCode` are **composite foreign keys** into
  `Keys (KeyboardModelId, HidCode)`. The database will not accept a remap whose
  source or target is not a real key on that model — the `0x64` case below is
  rejected even if a bug let it past validation.
- Carrying `KeyboardModelId` on the mapping is what makes those foreign keys
  possible, and the composite reference back to `UserKeyboards(Id,
  KeyboardModelId)` stops it from disagreeing with the keyboard it belongs to.
  The two constraints together mean *you cannot store a mapping to a key that
  does not exist on the keyboard you own.*
- `PRIMARY KEY (UserKeyboardId, FromHidCode)` makes "a physical key is remapped
  at most once" structural, so a duplicate add cannot corrupt state.
- `ON DELETE CASCADE` means deleting a user's keyboard takes its mappings with
  it, and retiring a model takes its keys with it.

Application-level validation still runs first, because it reports every problem
at once with a useful message; the constraints are the backstop.

In the serverless implementation the equivalent isolation is physical: the
DynamoDB partition key is derived from the `sub`, so one user's query cannot
read another's items even if application code asked it to.

### Adding new keys and keyboards

Because the catalog is data, extending it is a migration rather than a code
change. Adding the Apex Pro Gen 3's media keys, or a second keyboard model,
means a new migration inserting rows into `Keyboards` and `Keys` — no
recompile of the domain logic, and existing mappings are untouched.

The initial seed is generated rather than hand-typed:
[`packages/hid-catalog/generate.mjs`](packages/hid-catalog/generate.mjs) parses
the tables in [HidKeyCodes.md](HidKeyCodes.md) and emits the 92 seed rows, so
the assessment document is what the first migration reflects. That generator
runs **once**, at authoring time — the migration it produces is then committed
and frozen, as migrations must be. It is not part of the runtime or the build.

```bash
npm run catalog:generate     # regenerate seed data when the source doc changes
```

A drift test asserts the committed seed still matches the key tables in the
assessment document, so a silent divergence between the two implementations
fails the build.

## Authentication

Every `/api` route requires a bearer token from an **AWS Cognito** user pool.
The user is never named in a request body or URL — identity comes from the
token's `sub` claim, so a caller can only ever read and write their own
keyboards. There is no route that can address another user's data.

```http
POST /api/keyboards/apex-pro-gen-3/mappings
Authorization: Bearer <cognito-access-token>
```

| Condition | Response |
|---|---|
| Missing or malformed token | `401 Unauthorized` |
| Expired or bad signature | `401 Unauthorized` |
| Valid token, unknown keyboard model | `404 Not Found` |

A user's keyboard is **provisioned on first write**. A `POST` or `PUT` from a
user who has never touched `apex-pro-gen-3` inserts their `UserKeyboards` row
and applies the mappings in one transaction; there is no separate registration
step. A `GET` before any write returns the model's full key list with nothing
remapped, which is the honest answer and saves the client a special case.

### Validated in two places

The implementations enforce the same token differently, which is part of why
both exist:

- **.NET on ECS** validates in process. `AddJwtBearer` fetches the pool's JWKS,
  checks signature, issuer, audience and expiry, and `RequireAuthorization()`
  gates the route group. The ALB forwards everything; the app is the gate.
- **Serverless** validates at the edge. An API Gateway JWT authorizer verifies
  the token against the pool before Lambda is invoked, so unauthenticated
  traffic never reaches application code or costs an invocation. The handler
  reads the pre-verified `sub` out of the request context.

The second is less code and fails cheaper. The first works anywhere and is
testable without AWS. Same contract either way.

### Running locally without AWS

The brief requires the project to run locally, and Cognito is a hosted service,
so both APIs accept tokens from a **local dev issuer** when
`Auth:Mode=Development`. It signs RS256 tokens with a throwaway keypair and
serves its own JWKS, so the real validation path still runs — signature,
issuer, expiry and `sub` extraction are all genuinely exercised. Only the
issuer changes.

Seeded dev users (`alice`, `bob`) make per-user isolation demonstrable: remap a
key as `alice`, read it back as `bob`, and the layouts differ.

Development mode is selected by configuration and refuses to activate when
`ASPNETCORE_ENVIRONMENT=Production`, so the dev issuer cannot be trusted by a
deployed environment.

## API contract

Both implementations serve the same routes and the same JSON shapes, so the web
client can point at either without a code change. All `/api` routes require the
bearer token described above.

That is enforced rather than asserted.
[`packages/api-contract/openapi.yaml`](packages/api-contract/openapi.yaml) is a
hand-authored OpenAPI 3.1 document, and it is the source of truth: each backend
emits its own OpenAPI output at build time and CI fails on any difference from
it, while a single conformance suite runs against both running services to
check that identical requests actually produce identical responses. A document
diff alone would not catch two services that both *declare* `400` and disagree
about when to return it. See
[Keeping the two backends in contract](REPOSITORY.md#keeping-the-two-backends-in-contract).

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/keyboards` | Supported models, flagged with whether the caller owns one |
| `GET` | `/api/keyboards/{keyboard}/mappings` | Caller's full key list with remap state |
| `POST` | `/api/keyboards/{keyboard}/mappings` | **Add new mappings**, leaving existing ones in place |
| `PUT` | `/api/keyboards/{keyboard}/mappings` | Replace the caller's entire remap set |
| `DELETE` | `/api/keyboards/{keyboard}/mappings/{hidCode}` | Clear one key's remap |
| `DELETE` | `/api/keyboards/{keyboard}/mappings` | Clear all the caller's remaps |
| `GET` | `/health` | Liveness probe (unauthenticated) |

`{keyboard}` accepts either the slug (`apex-pro-gen-3`) or the display name
(`Apex Pro Gen 3`). Every route except `/health` resolves the owner from the
bearer token.

### Adding new mappings

`POST` adds remappings incrementally. Keys already remapped and not named in
the request keep their current target, so a client can bind one key without
first fetching and resending the whole layout.

```http
POST /api/keyboards/apex-pro-gen-3/mappings
Content-Type: application/json

{
  "mappings": [
    { "from": "0x39", "to": "0xE0" }
  ]
}
```

Sending a `from` that is already remapped **updates** it to the new target —
an upsert against the `(KeyboardId, FromHidCode)` primary key, not a duplicate
row and not a conflict. Remapping a key back to itself removes the override,
which is how a single binding gets cleared without a `DELETE`.

### Replacing the whole set

`PUT` is declarative: the request body becomes the complete set of
remappings, and anything absent from it is cleared. It is idempotent, so the
same request applied twice leaves the same state — the right fit for a client
that owns the full layout, such as a configuration UI with a Save button.

```http
PUT /api/keyboards/apex-pro-gen-3/mappings
Content-Type: application/json

{
  "mappings": [
    { "from": "0x04", "to": "0x1D" },
    { "from": "0x21", "to": "0x1F" }
  ]
}
```

Both writes accept HID codes as decimal integers or hex strings, apply in a
single transaction, and return `204 No Content` — the brief asks for no
response body beyond an indication of success or failure. A request that fails
validation changes nothing.

> The brief says only "assign key mappings", which could mean either write.
> Both are implemented because they answer different questions — "bind this one
> key" versus "here is my whole layout" — and collapsing them would force a
> read-modify-write race onto the client.

### Validation rules

All failures are reported together rather than stopping at the first, as
[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details:

- `from` and `to` are required and must be 8-bit HID codes (`0`–`255` / `0x00`–`0xFF`)
- both must be keys that exist on the target keyboard — `0x64` is a valid HID
  code but is not a row in `Keys` for this keyboard, so it is rejected
- a physical key may appear only once as `from` within a single request

The second and third rules are also enforced by the schema (composite foreign
keys and the `(KeyboardId, FromHidCode)` primary key), so they hold even if a
future caller bypasses this layer.

Two deliberate allowances:

- **Two keys may target the same key.** A real keyboard can have two physical
  keys that both emit `A`, so this is not an error — and nothing in the schema
  forbids it.
- **A key mapped to itself is valid and means "no remap".** It is normalized
  away, so storage only ever holds genuine overrides and `remappedCount`
  stays honest.

### Reading mappings

```http
GET /api/keyboards/apex-pro-gen-3/mappings
```

```json
{
  "keyboard": "Apex Pro Gen 3",
  "keyboardSlug": "apex-pro-gen-3",
  "totalKeys": 92,
  "remappedCount": 1,
  "keys": [
    {
      "hidCode": 4,
      "hidCodeHex": "0x04",
      "name": "A",
      "category": "Letters",
      "isRemapped": true,
      "mappedTo": { "hidCode": 29, "hidCodeHex": "0x1D", "name": "Z", "category": "Letters" }
    }
  ]
}
```

Every key on the keyboard is returned in HID code order, remapped or not, as
the brief requires. An un-remapped key reports `mappedTo` as *itself* rather
than `null`, so a client can render the effective layout without special-casing
either state.

## Running locally

| Needed for | | |
|---|---|---|
| Everything | **Node 22+** | |
| The .NET API | **.NET 10 SDK** | `global.json` declares the minimum |
| The serverless API | **Docker** | runs DynamoDB Local |

No licensed third-party packages are used, and no AWS account is required.

```bash
npm install
npm test                  # shared domain, contract, serverless handler, layout
npm run test:dotnet       # .NET unit and integration tests
```

### The whole stack

Four terminals. Each part is independently useful — start only what you need.

```bash
npm run dev:ddb           # DynamoDB Local in Docker, for the serverless API
npm run dev:serverless    # http://localhost:3000
npm run dev:dotnet        # http://localhost:5080
npm run dev:web           # http://localhost:5173
```

Then open <http://localhost:5173> and sign in through the Cognito hosted UI.
The **backend toggle** in the header switches the client between the two
implementations; the origin it is talking to is printed underneath it, so
there is never a question of which one answered.

Configuration is committed in [`apps/web/.env`](apps/web/.env), so there is no
setup step. Nothing in it is secret — a Cognito hosted-UI domain and a public
app client id, both of which any browser performing the login can see, which
is exactly why the client uses PKCE rather than a client secret. Personal
overrides go in `apps/web/.env.local`, which stays ignored.

> Signing in locally still uses the **real** Cognito pool, because that is the
> one part of the flow with nothing to stand in for it. Everything else —
> both APIs, both datastores — runs on your machine.

### The .NET API

Migrations are applied automatically on startup, so the first run creates
`apex.db`, seeds the 92 keys, and the database then persists between runs as
the brief requires. No AWS account is needed.

```bash
npm run dev:dotnet        # or: dotnet run --project apps/api-dotnet/Apex.KeyMapping.Api
```

Remap Caps Lock to Left Ctrl, then read the layout back:

```bash
curl -X POST localhost:5080/api/keyboards/apex-pro-gen-3/mappings \
  -H 'Content-Type: application/json' \
  -d '{"mappings":[{"from":"0x39","to":"0xE0"}]}'

curl -s localhost:5080/api/keyboards/apex-pro-gen-3/mappings | jq '.remappedCount'
```

Those commands carry no token, and they work — because with no
`Auth:Authority` configured the API falls back to identifying the caller by an
`X-Dev-User` header that defaults to `alice`. That is a development
convenience, not authentication, and it is only registered outside Production;
anywhere else the same requests answer 401. The deployed API validates real
Cognito tokens.

Per-user isolation is demonstrable by naming someone else — same database,
different owner, different answer:

```bash
curl -s localhost:5080/api/keyboards/apex-pro-gen-3/mappings \
  -H 'X-Dev-User: bob' | jq '.remappedCount'      # 0
```

The brief's own example, end to end:

```bash
curl -X POST localhost:5080/api/keyboards/apex-pro-gen-3/mappings \
  -H 'Content-Type: application/json' \
  -d '{"mappings":[{"from":"0x04","to":"0x1D"},{"from":"0x21","to":"0x1F"}]}'
```

`{keyboard}` also accepts the display name, so
`localhost:5080/api/keyboards/Apex%20Pro%20Gen%203/mappings` resolves to the
same keyboard.

### Postman

[`postman/`](postman) holds a collection and a local environment, both
generated from the OpenAPI contract so they cannot drift from it. Import both
files, or run the collection headlessly against a running API:

```bash
npm run postman:generate   # after any contract change
npm run postman:test       # runs the end-to-end scenario via newman
```

The collection is more than a set of example requests. Alongside one folder
per operation there is a **scenario folder** that runs in order and asserts
the answers: it applies the brief's own mappings, reads back the full layout,
checks a second user sees nothing, clears one binding by self-mapping it,
confirms an invalid remap is rejected with every error at once and changes
nothing, and cleans up. 19 requests, 38 assertions.

Because every request targets `{{baseUrl}}`, the same collection runs against
either implementation — which makes it a cheap first version of the
cross-backend conformance suite in step 4 of the roadmap.

To inspect or reset the database:

```bash
dotnet ef migrations list --project apps/api-dotnet/Apex.KeyMapping.Api
rm apps/api-dotnet/Apex.KeyMapping.Api/apex.db    # next run re-creates and re-seeds
```

### The serverless API

The handler is a pure function from an API Gateway event to a response, so it
runs anywhere. What AWS supplies in production is three things, and a dev
server stands in for them: the HTTP-to-event translation API Gateway performs,
the verified `sub` the JWT authorizer attaches, and DynamoDB itself.

```bash
npm run dev:ddb          # DynamoDB Local in Docker, in another terminal
npm run dev:serverless   # http://localhost:3000
```

The table is created on first run, so there is no setup step. Identity comes
from a bearer token — decoded, **not verified** — or from `X-Dev-User`, the
same header the .NET API accepts in development, so the two local experiences
match.

> That stand-in is the honest limit of running this locally: it proves the
> handler is correct, not that authentication is. Verification only happens
> for real at the API Gateway edge, which is also why the serverless
> implementation has no JWKS code to test — there is nothing to test.

The same Postman collection passes **38 assertions** against the local server,
both deployments, and the local .NET API. Four environments ship in
[`postman/`](postman) for exactly that reason:

| Environment | Points at |
|---|---|
| `local.postman_environment.json` | `localhost:5080` — the .NET API |
| `local-serverless.postman_environment.json` | `localhost:3000` — the dev server |
| `dotnet.postman_environment.json` | The deployed .NET API, via CloudFront |
| `serverless.postman_environment.json` | The deployed serverless API |

Each needs a `password` filling in; it is the one value deliberately left
blank. [apps/api-dotnet/REPOSITORY.md](apps/api-dotnet/REPOSITORY.md) covers
the .NET project in depth, including for readers new to .NET.

## Deployed

Everything runs in AWS, described entirely by CDK in [`infra/`](infra). Five
stacks, split by lifecycle rather than convenience:

| Stack | What | Why separate |
|---|---|---|
| `ApexIdentity` | Cognito user pool, app client, hosted UI domain | Accounts must outlive any backend |
| `ApexDotnetApi` | VPC, EFS, ECS Fargate, ALB | The expensive one — `cdk destroy` stops the billing without losing users |
| `ApexServerlessApi` | Lambda, DynamoDB, HTTP API with a JWT authorizer | Bills per request; deploys independently of the .NET one |
| `ApexWeb` | S3 bucket and the CloudFront distribution fronting both it and the .NET API | A CSS change should not redeploy a Fargate service |
| `ApexGithubDeploy` | OIDC provider and the deploy role | Deployed by hand; the pipeline cannot create its own access |

### How a deploy happens

Four workflows, one per stack, each triggered by the paths it owns. Every one
deploys `--exclusively`, so a push that touches shared code does not have
three pipelines racing to update the same CloudFormation stack.

| Workflow | Fires on | Deploys |
|---|---|---|
| `deploy-identity` | `shared-identity-stack.ts`, `bin/infra.ts` | `ApexIdentity` |
| `deploy-dotnet` | `apps/api-dotnet/**`, `infra/**`, `packages/**` | `ApexDotnetApi` |
| `deploy-serverless` | `apps/api-serverless/**`, `packages/**` | `ApexServerlessApi` |
| `deploy-web` | `apps/web/**`, `packages/hid-catalog/**` | `ApexWeb` |

Each runs the relevant test lanes first, assumes a role via OIDC with no
stored AWS key, deploys, and then smoke-tests that `/health` answers **and
that `/api/keyboards` returns 401 without a token** — a green deploy serving
data to anonymous callers is worse than a failed one. The .NET pipeline also
diffs the API's generated OpenAPI document against the canonical contract.

### The web client

[`apps/web`](apps/web) is a Vite + React + Bootstrap client served from a
private S3 bucket through CloudFront. It signs in with the Cognito hosted UI
using the authorization code flow with PKCE, written by hand rather than
pulled from an OIDC library — the flow is about a hundred lines of Web Crypto,
and for one provider that is easier to audit than a dependency.

**One distribution serves both the client and the API**, which is three
decisions in one:

- Cognito permits plain HTTP callbacks only for `localhost`, so the client
  must be on HTTPS. S3 website hosting is HTTP-only and cannot be the redirect
  target.
- An HTTPS page may not call an HTTP API, and the ALB has no certificate
  because it has no domain to get one for. CloudFront terminates TLS for the
  browser and talks HTTP to the ALB inside AWS.
- Serving `/api` from the same origin means **no CORS** — no preflight, and no
  cross-origin configuration to get wrong.

The API behavior has caching disabled outright. Responses are per-user, and a
cached `200` served to the wrong bearer token is a data leak rather than a
stale page.

```bash
npm run dev:web    # http://localhost:5173, proxying /api to the local API
```

The Cognito callback list has to contain the client's origin, which does not
exist until CloudFront deploys. That circularity is a deliberate two-step
rather than a custom resource:

```bash
npx cdk deploy ApexWeb                                      # prints the origin
npx cdk deploy ApexIdentity -c webOrigin=https://xxx.cloudfront.net
```

### Getting a token

```bash
TOKEN=$(aws cognito-idp initiate-auth \
  --client-id "$CLIENT_ID" --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=alice,PASSWORD='…' \
  --query 'AuthenticationResult.AccessToken' --output text)

curl -s "$API_URL/api/keyboards/apex-pro-gen-3/mappings" \
  -H "Authorization: Bearer $TOKEN" | jq '.remappedCount'
```

`CLIENT_ID` and `API_URL` are stack outputs — `npx cdk deploy` prints them, or
read them back with `aws cloudformation describe-stacks`.

### What running it proved

Three things that local testing could not:

- **Fargate's disk is ephemeral**, so the brief's "persists between runs" is
  meaningless in a container without somewhere durable to write. SQLite lives
  on an EFS mount; killing the task and letting ECS replace it leaves the
  database intact. That was verified by doing it, not by assuming it.
- **One writer, always.** SQLite permits a single writer, so the service is
  pinned to one task and deployments stop the old one before starting the
  new one. It does not scale horizontally, which is the honest limit of
  answering the brief literally.
- **No NAT Gateway.** Tasks run in public subnets with public IPs. A private
  subnet layout is the usual production answer and costs ~$32/month in NAT
  charges to hide a service that is deliberately internet-facing.

## Roadmap

1. [x] Shared domain rules and seed generation, with drift tests
2. [x] Canonical OpenAPI contract, validated against the domain catalog
3. [x] ASP.NET Core 10 API: EF Core schema + seed migration, SQLite, integration tests
4. [x] AWS CDK infrastructure: Cognito, ECS Fargate, EFS, ALB
5. [x] Cognito JWT validation, replacing the `X-Dev-User` seam outside Development
6. [x] GitHub Actions pipeline deploying to AWS via OIDC
7. [x] React client on S3 + CloudFront, signing in through the Cognito hosted UI
8. [ ] Local dev issuer, so the real validation path runs without AWS
9. [x] TypeScript serverless API with DynamoDB, passing the same conformance suite
10. [x] Shared conformance suite run against both implementations

Steps 4 to 6 jumped ahead of the original order. Deploying earlier than
planned turned out to be worth it: standing the service up surfaced three
problems that no amount of local testing would have — an OIDC subject claim
that does not look like the documentation suggests, a `.gitignore` rule that
silently excluded the CDK entry point, and the fact that Fargate's ephemeral
disk makes the brief's persistence requirement meaningless without EFS.

The client still comes before the second API. A real consumer exercising the
contract is a better check than another test asserting the shape I already
expect, and anything awkward in the JSON surfaces while there is still only
one backend to change.
