#!/usr/bin/env node
// Generates a Postman collection from the canonical OpenAPI document.
//
// The collection is a derived artifact, like keys.json and CatalogSeed.g.cs:
// routes, methods, descriptions and request bodies all come out of
// openapi.yaml, so a contract change regenerates the collection rather than
// leaving a second, quietly diverging description of the API.
//
// What is *not* derived is the assertions. A plain OpenAPI-to-Postman
// conversion gives you an API browser — requests you can fire, with nothing
// checking the answers. The test scripts below are what make this a way to
// test the service, and the scenario folder is an ordered walk through the
// behavior the brief actually asks for.
//
// Because every request targets {{baseUrl}}, the same collection runs against
// either implementation. That makes it a cheap first version of the
// cross-backend conformance suite in roadmap step 4.
//
//   npm run postman:generate
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const spec = parse(readFileSync(join(here, "openapi.yaml"), "utf8"));
const catalog = JSON.parse(readFileSync(join(here, "..", "hid-catalog", "keys.json"), "utf8"));

const keyboard = catalog.keyboards[0];
const totalKeys = keyboard.keys.length;

const outDir = join(repoRoot, "postman");
const COLLECTION_SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

/** Resolves a local $ref against the spec. */
const deref = (node) => {
  let current = node;
  while (current && typeof current.$ref === "string") {
    current = current.$ref
      .replace(/^#\//, "")
      .split("/")
      .reduce((acc, part) => acc?.[part], spec);
  }
  return current;
};

const script = (...lines) => ({
  listen: "test",
  script: { type: "text/javascript", exec: lines.flat() },
});

/** Builds a Postman url object. Postman wants the pieces, not just the string. */
const url = (path, query = []) => ({
  raw: `{{baseUrl}}${path}`,
  host: ["{{baseUrl}}"],
  path: path.replace(/^\//, "").split("/"),
  ...(query.length ? { query } : {}),
});

const jsonBody = (value) => ({
  mode: "raw",
  raw: JSON.stringify(value, null, 2),
  options: { raw: { language: "json" } },
});

/**
 * Both deployments authenticate with real Cognito access tokens — the .NET
 * API validates them in middleware, the serverless one at the API Gateway
 * edge. `{{accessToken}}` is minted by the collection-level pre-request
 * script below, so the collection needs no manual setup beyond credentials.
 */
const request = ({ name, method, path, body, description, tests = [], auth = true, as }) => ({
  name,
  request: {
    method,
    header: [
      ...(body ? [{ key: "Content-Type", value: "application/json" }] : []),
      ...(auth
        ? [{ key: "Authorization", value: `Bearer {{${as === "other" ? "accessTokenOther" : "accessToken"}}}` }]
        : []),
    ],
    url: url(path),
    ...(body ? { body: jsonBody(body) } : {}),
    description,
  },
  event: tests.length ? [script(tests)] : [],
});

/**
 * Runs before every request. Exchanges a username and password for an access
 * token via Cognito's InitiateAuth, which needs no AWS signature, and caches
 * it until it expires.
 *
 * Two users, because proving per-user isolation needs two identities and the
 * whole point of the scenario is that the same request returns different
 * answers depending on who asks.
 */
const AUTH_PREREQUEST = [
  `const region = pm.variables.get("cognitoRegion");`,
  `const clientId = pm.variables.get("cognitoClientId");`,
  ``,
  `// Cognito tokens last an hour; refresh a minute early so one does not`,
  `// expire midway through a collection run.`,
  `const fresh = (key) => {`,
  `    const token = pm.collectionVariables.get(key);`,
  `    const expiry = Number(pm.collectionVariables.get(key + "ExpiresAt") || 0);`,
  `    return token && expiry > Date.now() + 60000;`,
  `};`,
  ``,
  `// Callback style, not promises: the sandbox waits for in-flight`,
  `// pm.sendRequest calls before sending the actual request, but a dangling`,
  `// promise it does not know about would race.`,
  `const signIn = (username, password, key) => {`,
  `    pm.sendRequest({`,
  `        url: "https://cognito-idp." + region + ".amazonaws.com/",`,
  `        method: "POST",`,
  `        header: {`,
  `            "Content-Type": "application/x-amz-json-1.1",`,
  `            "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",`,
  `        },`,
  `        body: { mode: "raw", raw: JSON.stringify({`,
  `            AuthFlow: "USER_PASSWORD_AUTH",`,
  `            ClientId: clientId,`,
  `            AuthParameters: { USERNAME: username, PASSWORD: password },`,
  `        }) },`,
  `    }, (err, res) => {`,
  `        if (err) { console.error("Sign-in request failed for " + username, err); return; }`,
  `        const body = res.json();`,
  `        if (!body.AuthenticationResult) {`,
  `            console.error("Sign-in rejected for " + username + ": " + (body.message || res.code));`,
  `            return;`,
  `        }`,
  `        pm.collectionVariables.set(key, body.AuthenticationResult.AccessToken);`,
  `        pm.collectionVariables.set(key + "ExpiresAt",`,
  `            String(Date.now() + body.AuthenticationResult.ExpiresIn * 1000));`,
  `    });`,
  `};`,
  ``,
  `if (!fresh("accessToken")) {`,
  `    signIn(pm.variables.get("username"), pm.variables.get("password"), "accessToken");`,
  `}`,
  `if (!fresh("accessTokenOther")) {`,
  `    signIn(pm.variables.get("usernameOther"), pm.variables.get("password"), "accessTokenOther");`,
  `}`,
];

// ── Assertions ──────────────────────────────────────────────────────────────

const expectStatus = (code) => [
  `pm.test("responds ${code}", () => pm.response.to.have.status(${code}));`,
];

const expectProblemDetails = (code) => [
  ...expectStatus(code),
  `pm.test("is RFC 9457 problem details", () => {`,
  `    pm.expect(pm.response.headers.get("Content-Type")).to.include("application/problem+json");`,
  `    const body = pm.response.json();`,
  `    pm.expect(body).to.have.all.keys("type", "title", "status", "detail", ...(body.errors ? ["errors"] : []));`,
  `    pm.expect(body.status).to.eql(${code});`,
  `});`,
];

const expectFullLayout = [
  ...expectStatus(200),
  `pm.test("returns every key, remapped or not", () => {`,
  `    const body = pm.response.json();`,
  `    pm.expect(body.totalKeys).to.eql(${totalKeys});`,
  `    pm.expect(body.keys).to.have.lengthOf(${totalKeys});`,
  `    pm.expect(body.keyboardSlug).to.eql("${keyboard.slug}");`,
  `});`,
  `pm.test("every key reports an effective target", () => {`,
  `    // An un-remapped key maps to itself rather than null, so a client`,
  `    // never has to special-case the two states.`,
  `    pm.response.json().keys.forEach((key) => {`,
  `        pm.expect(key.mappedTo, \`\${key.hidCodeHex} mappedTo\`).to.be.an("object");`,
  `        if (!key.isRemapped) pm.expect(key.mappedTo.hidCode).to.eql(key.hidCode);`,
  `    });`,
  `});`,
  `pm.test("keys are in ascending HID code order", () => {`,
  `    const codes = pm.response.json().keys.map((k) => k.hidCode);`,
  `    pm.expect(codes).to.eql([...codes].sort((a, b) => a - b));`,
  `});`,
];

const remappedCountIs = (expected, label) => [
  `pm.test("${label}", () => {`,
  `    pm.expect(pm.response.json().remappedCount).to.eql(${expected});`,
  `});`,
];

// ── Reference folders, one request per operation in the contract ────────────

const bodyExample = (operationId, exampleName) => {
  const operation = Object.values(spec.paths)
    .flatMap((item) => Object.values(item))
    .find((op) => op?.operationId === operationId);

  const content = deref(operation.requestBody).content["application/json"];
  return content.examples[exampleName].value;
};

const MAPPINGS = "/api/keyboards/{{keyboard}}/mappings";

const reference = [
  {
    name: "Health",
    description: "Unauthenticated liveness probe.",
    item: [
      request({
        name: "GET /health",
        method: "GET",
        path: "/health",
        auth: false,
        description: spec.paths["/health"].get.description,
        tests: [
          ...expectStatus(200),
          `pm.test("reports healthy", () => pm.expect(pm.response.json().status).to.eql("healthy"));`,
        ],
      }),
    ],
  },
  {
    name: "Keyboards",
    description: "Which models this service supports.",
    item: [
      request({
        name: "GET /api/keyboards",
        method: "GET",
        path: "/api/keyboards",
        description: spec.paths["/api/keyboards"].get.description,
        tests: [
          ...expectStatus(200),
          `pm.test("includes the Apex Pro Gen 3 with ${totalKeys} keys", () => {`,
          `    const model = pm.response.json().keyboards.find((k) => k.slug === "${keyboard.slug}");`,
          `    pm.expect(model, "apex-pro-gen-3 missing").to.be.an("object");`,
          `    pm.expect(model.totalKeys).to.eql(${totalKeys});`,
          `    pm.expect(model.owned).to.be.a("boolean");`,
          `});`,
        ],
      }),
    ],
  },
  {
    name: "Mappings",
    description:
      "The read and write operations. Each targets {{keyboard}}, which accepts " +
      "the slug or the display name.",
    item: [
      request({
        name: "GET mappings",
        method: "GET",
        path: MAPPINGS,
        description: spec.paths["/api/keyboards/{keyboard}/mappings"].get.description,
        tests: expectFullLayout,
      }),
      request({
        name: "POST add mappings — the brief's example",
        method: "POST",
        path: MAPPINGS,
        body: bodyExample("addMappings", "fromTheBrief"),
        description: spec.paths["/api/keyboards/{keyboard}/mappings"].post.description,
        tests: expectStatus(204),
      }),
      request({
        name: "POST add mappings — Caps Lock to Left Ctrl",
        method: "POST",
        path: MAPPINGS,
        body: bodyExample("addMappings", "capsLockToCtrl"),
        description: "Incremental: keys already remapped and not named here keep their target.",
        tests: expectStatus(204),
      }),
      request({
        name: "POST add mappings — clear one by mapping it to itself",
        method: "POST",
        path: MAPPINGS,
        body: bodyExample("addMappings", "clearOne"),
        description: "Remapping a key back to itself removes the override.",
        tests: expectStatus(204),
      }),
      request({
        name: "PUT replace mappings",
        method: "PUT",
        path: MAPPINGS,
        body: bodyExample("replaceMappings", "fromTheBrief"),
        description: spec.paths["/api/keyboards/{keyboard}/mappings"].put.description,
        tests: expectStatus(204),
      }),
      request({
        name: "DELETE one mapping",
        method: "DELETE",
        path: `${MAPPINGS}/0x04`,
        description: spec.paths["/api/keyboards/{keyboard}/mappings/{hidCode}"].delete.description,
        tests: expectStatus(204),
      }),
      request({
        name: "DELETE all mappings",
        method: "DELETE",
        path: MAPPINGS,
        description: spec.paths["/api/keyboards/{keyboard}/mappings"].delete.description,
        tests: expectStatus(204),
      }),
    ],
  },
];

// ── Scenario: ordered, asserts behavior rather than just shape ─────────────

const scenario = {
  name: "Scenario — the brief, end to end",
  description:
    "Run this folder in order (Postman Runner, or `npm run postman:test`). It " +
    "walks the behavior the assessment asks for and checks the answers, " +
    "rather than only checking that the routes exist.",
  item: [
    request({
      name: "1. Start from a clean layout",
      method: "DELETE",
      path: MAPPINGS,
      description: "Idempotent, so this is safe whether or not anything was remapped.",
      tests: expectStatus(204),
    }),
    request({
      name: "2. Assign the brief's mappings",
      method: "POST",
      path: MAPPINGS,
      body: bodyExample("addMappings", "fromTheBrief"),
      description: '"A (0x04)" should remap to "Z (0x1D)", and "4 (0x21)" to "2 (0x1F)".',
      tests: expectStatus(204),
    }),
    request({
      name: "3. Read back the full layout",
      method: "GET",
      path: MAPPINGS,
      description: "Every key on the keyboard, remapped or not, as the brief requires.",
      tests: [
        ...expectFullLayout,
        ...remappedCountIs(2, "exactly the two requested keys are remapped"),
        `pm.test("A maps to Z, and 4 maps to 2", () => {`,
        `    const keys = pm.response.json().keys;`,
        `    const find = (code) => keys.find((k) => k.hidCode === code);`,
        ``,
        `    pm.expect(find(0x04).name).to.eql("A");`,
        `    pm.expect(find(0x04).isRemapped).to.be.true;`,
        `    pm.expect(find(0x04).mappedTo.name).to.eql("Z");`,
        `    pm.expect(find(0x04).mappedTo.hidCodeHex).to.eql("0x1D");`,
        ``,
        `    pm.expect(find(0x21).name).to.eql("4");`,
        `    pm.expect(find(0x21).mappedTo.name).to.eql("2");`,
        `});`,
        `pm.test("remapping A to Z leaves Z itself alone", () => {`,
        `    const z = pm.response.json().keys.find((k) => k.hidCode === 0x1D);`,
        `    pm.expect(z.isRemapped).to.be.false;`,
        `    pm.expect(z.mappedTo.hidCode).to.eql(0x1D);`,
        `});`,
      ],
    }),
    request({
      name: "4. A different user sees their own layout",
      method: "GET",
      path: MAPPINGS,
      as: "other",
      description:
        "A second real Cognito identity, not a different header value. Same " +
        "store, same keyboard, different `sub`. Identity comes from the token " +
        "and no route accepts a user, so there is no way to ask for someone " +
        "else's layout.",
      tests: [
        ...expectStatus(200),
        ...remappedCountIs(0, "another user has nothing remapped"),
        `pm.test("but still gets the whole keyboard", () => {`,
        `    pm.expect(pm.response.json().totalKeys).to.eql(${totalKeys});`,
        `});`,
      ],
    }),
    request({
      name: "5. Clearing one binding by mapping it to itself",
      method: "POST",
      path: MAPPINGS,
      body: { mappings: [{ from: "0x04", to: "0x04" }] },
      description:
        "Regression guard. Validation strips identity mappings before the merge " +
        "sees them, so this path was once silently a no-op while both halves " +
        "passed their own unit tests.",
      tests: expectStatus(204),
    }),
    request({
      name: "6. Only the cleared key went away",
      method: "GET",
      path: MAPPINGS,
      tests: [
        ...expectStatus(200),
        ...remappedCountIs(1, "one of the two remains"),
        `pm.test("0x04 was cleared and 0x21 survived", () => {`,
        `    const remapped = pm.response.json().keys.filter((k) => k.isRemapped).map((k) => k.hidCode);`,
        `    pm.expect(remapped).to.eql([0x21]);`,
        `});`,
      ],
    }),
    request({
      name: "7. An invalid remap is rejected with every error at once",
      method: "POST",
      path: MAPPINGS,
      body: {
        mappings: [
          { from: "0x04", to: "0x64" },
          { from: "0x05", to: "0x06" },
          { from: "0x05", to: "0x07" },
        ],
      },
      description:
        "0x64 is a real HID usage code but not a key on this keyboard, and 0x05 " +
        "appears twice as a source. Both are reported together, and the request " +
        "changes nothing.",
      tests: [
        ...expectProblemDetails(400),
        `pm.test("reports both problems, not just the first", () => {`,
        `    const errors = pm.response.json().errors;`,
        `    pm.expect(errors).to.have.lengthOf(2);`,
        `    pm.expect(errors[0]).to.deep.include({ index: 0, field: "to" });`,
        `    pm.expect(errors[0].message).to.include("not a key on");`,
        `    pm.expect(errors[1]).to.deep.include({ index: 2, field: "from" });`,
        `    pm.expect(errors[1].message).to.include("remapped more than once");`,
        `});`,
      ],
    }),
    request({
      name: "8. The rejected request changed nothing",
      method: "GET",
      path: MAPPINGS,
      tests: [...expectStatus(200), ...remappedCountIs(1, "still just the one mapping")],
    }),
    request({
      name: "9. An unknown keyboard is a 404",
      method: "GET",
      path: "/api/keyboards/model-m/mappings",
      tests: expectProblemDetails(404),
    }),
    request({
      name: "10. Clean up",
      method: "DELETE",
      path: MAPPINGS,
      tests: expectStatus(204),
    }),
  ],
};

// ── Emit ────────────────────────────────────────────────────────────────────

const collection = {
  info: {
    name: "Apex Key Remapping",
    schema: COLLECTION_SCHEMA,
    description:
      `${spec.info.title} ${spec.info.version}\n\n` +
      "GENERATED from packages/api-contract/openapi.yaml — regenerate with " +
      "`npm run catalog:generate`'s sibling, `npm run postman:generate`, " +
      "rather than editing here.\n\n" +
      "Point {{baseUrl}} at either implementation; both answer the same " +
      "contract. Run the scenario folder in order with the Collection Runner, " +
      "or headlessly with `npm run postman:test`.",
  },
  item: [...reference, scenario],

  // Runs before every request, minting tokens once and reusing them.
  event: [{ listen: "prerequest", script: { type: "text/javascript", exec: AUTH_PREREQUEST } }],

  variable: [
    { key: "baseUrl", value: "http://localhost:5080", type: "string" },
    { key: "keyboard", value: keyboard.slug, type: "string" },
  ],
};

/**
 * One environment per deployment. The same collection runs against both,
 * which is the whole point — if the two implementations disagree, the same
 * 38 assertions cannot pass twice.
 */
const environmentFor = (name, baseUrl) => ({
  name,
  values: [
    { key: "baseUrl", value: baseUrl, type: "default", enabled: true },
    { key: "keyboard", value: keyboard.slug, type: "default", enabled: true },
    { key: "cognitoRegion", value: "us-east-1", type: "default", enabled: true },
    { key: "cognitoClientId", value: "16k15j46dasjhd8okl0vr7kuid", type: "default", enabled: true },
    { key: "username", value: "alice", type: "default", enabled: true },
    { key: "usernameOther", value: "bob", type: "default", enabled: true },
    // Left blank deliberately. Filling it in is a local step, not something
    // that belongs in version control.
    { key: "password", value: "", type: "secret", enabled: true },
  ],
  _postman_variable_scope: "environment",
});

mkdirSync(outDir, { recursive: true });

const collectionPath = join(outDir, "apex-key-remapping.postman_collection.json");
writeFileSync(collectionPath, `${JSON.stringify(collection, null, 2)}\n`);

// Deployed URLs are stack outputs, not secrets, and committing them is what
// makes `npm run postman:test` work without a setup ritual. Only the password
// is left blank. If a stack is destroyed and recreated these change — read
// them back with `aws cloudformation describe-stacks`.
const environments = [
  ["local.postman_environment.json", "Apex — local .NET", "http://localhost:5080"],
  ["dotnet.postman_environment.json", "Apex — deployed .NET", "https://d3isop0e6bhby8.cloudfront.net"],
  [
    "serverless.postman_environment.json",
    "Apex — deployed serverless",
    "https://qb3okpgoo6.execute-api.us-east-1.amazonaws.com",
  ],
];

for (const [file, name, baseUrl] of environments) {
  writeFileSync(join(outDir, file), `${JSON.stringify(environmentFor(name, baseUrl), null, 2)}\n`);
}

const countRequests = (items) =>
  items.reduce((total, item) => total + (item.item ? countRequests(item.item) : 1), 0);

console.log(`Wrote:\n  ${collectionPath}`);
for (const [file] of environments) console.log(`  ${join(outDir, file)}`);
console.table({
  folders: collection.item.length,
  requests: countRequests(collection.item),
  "reference requests": countRequests(reference),
  "scenario steps": scenario.item.length,
});
