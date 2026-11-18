#!/usr/bin/env node
// Validates the canonical OpenAPI document.
//
// Two kinds of check run here. The structural ones (refs resolve, operation
// ids are unique, every secured route documents its 401) are the sort any
// OpenAPI linter does. The ones that matter more are the domain checks: every
// HID code, key name and key count that appears in an example is verified
// against packages/hid-catalog, so the contract cannot quietly describe a
// keyboard that does not exist.
//
// A spec that drifts from the catalog is worse than no spec, because both
// backends are written against it.
//
//   npm run contract:validate
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const specPath = join(here, "openapi.yaml");
const catalogPath = join(here, "..", "hid-catalog", "keys.json");

const failures = [];
const fail = (check, detail) => failures.push({ check, detail });

const spec = parse(readFileSync(specPath, "utf8"));
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));

const keyboard = catalog.keyboards.find((k) => k.slug === "apex-pro-gen-3");
if (!keyboard) throw new Error("apex-pro-gen-3 missing from keys.json — regenerate the catalog.");

const keysByCode = new Map(keyboard.keys.map((k) => [k.hidCode, k]));
const catalogCategories = [...new Set(keyboard.keys.map((k) => k.category))].sort();

// ── Structure ───────────────────────────────────────────────────────────────

if (!String(spec.openapi ?? "").startsWith("3.1")) {
  fail("openapi version", `expected 3.1.x, found ${spec.openapi}`);
}

/** Walks every node, yielding [path, value] so checks can look anywhere. */
function* walk(node, path = []) {
  if (node === null || typeof node !== "object") return;
  yield [path, node];
  for (const [key, value] of Object.entries(node)) {
    yield* walk(value, [...path, key]);
  }
}

const resolve = (ref) =>
  ref
    .replace(/^#\//, "")
    .split("/")
    .reduce((node, segment) => (node == null ? undefined : node[segment]), spec);

for (const [path, node] of walk(spec)) {
  if (typeof node.$ref === "string" && resolve(node.$ref) === undefined) {
    fail("unresolved $ref", `${node.$ref} at /${path.join("/")}`);
  }
}

const METHODS = ["get", "put", "post", "delete", "patch"];
const operations = [];
for (const [route, item] of Object.entries(spec.paths ?? {})) {
  for (const method of METHODS) {
    if (item[method]) operations.push({ route, method, op: item[method] });
  }
}

if (operations.length === 0) fail("operations", "the spec declares no operations");

const seenIds = new Map();
for (const { route, method, op } of operations) {
  const where = `${method.toUpperCase()} ${route}`;

  if (!op.operationId) {
    fail("missing operationId", where);
  } else if (seenIds.has(op.operationId)) {
    fail("duplicate operationId", `${op.operationId} on ${where} and ${seenIds.get(op.operationId)}`);
  } else {
    seenIds.set(op.operationId, where);
  }

  if (!op.summary) fail("missing summary", where);

  const responses = Object.keys(op.responses ?? {});
  if (responses.length === 0) fail("no responses declared", where);

  // `security: []` opts an operation out of the global requirement.
  const isPublic = Array.isArray(op.security) && op.security.length === 0;
  if (!isPublic && !responses.includes("401")) {
    fail("secured route without documented 401", where);
  }
  if (isPublic && responses.includes("401")) {
    fail("public route documents a 401", where);
  }

  // Anything with a body can fail validation, and the contract promises that
  // failure is reported as problem details rather than a bare status.
  if (op.requestBody && !responses.includes("400")) {
    fail("route accepts a body but documents no 400", where);
  }
}

// ── Domain: the spec must describe the keyboard we actually have ────────────

const categoryEnum = spec.components?.schemas?.HidKey?.properties?.category?.enum;
if (!Array.isArray(categoryEnum)) {
  fail("HidKey.category", "expected an enum of categories");
} else {
  const declared = [...categoryEnum].sort();
  if (declared.join() !== catalogCategories.join()) {
    fail(
      "category enum drift",
      `spec has [${declared.join(", ")}], catalog has [${catalogCategories.join(", ")}]`,
    );
  }
}

/** Mirrors parseHidCode in hid-catalog: decimal wins when a string could be either. */
function parseHidCode(value) {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 && value <= 255 ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const hex = /^0[xX]([0-9A-Fa-f]{1,2})$/.exec(trimmed);
  if (hex) return Number.parseInt(hex[1], 16);
  if (/^\d{1,3}$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    return n >= 0 && n <= 255 ? n : null;
  }
  if (/^[0-9A-Fa-f]{1,2}$/.test(trimmed)) return Number.parseInt(trimmed, 16);
  return null;
}

const toHex = (code) => `0x${code.toString(16).toUpperCase().padStart(2, "0")}`;

let keyShapesChecked = 0;
let mappingsChecked = 0;
let countsChecked = 0;

for (const [path, node] of walk(spec)) {
  const at = `/${path.join("/")}`;

  // A rendered key: { hidCode, hidCodeHex, name, category }
  if (typeof node.hidCode === "number" && typeof node.name === "string" && node.category) {
    keyShapesChecked += 1;
    const actual = keysByCode.get(node.hidCode);
    if (!actual) {
      fail("example uses a key that does not exist", `${toHex(node.hidCode)} at ${at}`);
    } else {
      if (node.name !== actual.name) {
        fail("example key name wrong", `${toHex(node.hidCode)} is "${actual.name}", spec says "${node.name}" at ${at}`);
      }
      if (node.category !== actual.category) {
        fail(
          "example key category wrong",
          `${toHex(node.hidCode)} is ${actual.category}, spec says ${node.category} at ${at}`,
        );
      }
      if (node.hidCodeHex !== undefined && node.hidCodeHex !== actual.hidCodeHex) {
        fail("example hex rendering wrong", `${actual.hidCodeHex} expected, spec says ${node.hidCodeHex} at ${at}`);
      }
    }
  }

  // A requested mapping: { from, to }
  if (node.from !== undefined && node.to !== undefined && !node.$ref) {
    for (const end of ["from", "to"]) {
      const raw = node[end];
      if (typeof raw !== "string" && typeof raw !== "number") continue;
      mappingsChecked += 1;
      const code = parseHidCode(raw);
      if (code === null) {
        fail("example mapping is unparseable", `${end}: ${JSON.stringify(raw)} at ${at}`);
      } else if (!keysByCode.has(code)) {
        fail("example remaps a key that does not exist", `${end}: ${toHex(code)} at ${at}`);
      }
    }
  }

  // Any example claiming how many keys the keyboard has.
  for (const field of ["totalKeys"]) {
    const value = node[field];
    const isExample = typeof value === "number";
    const isExamplesArray = Array.isArray(node[field]?.examples);
    if (isExample && !isExamplesArray) {
      countsChecked += 1;
      if (value !== keyboard.keys.length) {
        fail("key count drift", `${field} is ${value} at ${at}, catalog has ${keyboard.keys.length}`);
      }
    }
  }
  if (Array.isArray(node.examples) && path.at(-1) === "totalKeys") {
    for (const value of node.examples) {
      if (typeof value !== "number") continue;
      countsChecked += 1;
      if (value !== keyboard.keys.length) {
        fail("key count drift", `totalKeys example is ${value} at ${at}, catalog has ${keyboard.keys.length}`);
      }
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`\n✗ openapi.yaml failed ${failures.length} check(s):\n`);
  for (const { check, detail } of failures) console.error(`  • ${check}: ${detail}`);
  console.error("");
  process.exit(1);
}

console.log("✓ openapi.yaml is valid and agrees with the catalog");
console.table({
  operations: operations.length,
  schemas: Object.keys(spec.components?.schemas ?? {}).length,
  "example keys verified": keyShapesChecked,
  "example mappings verified": mappingsChecked,
  "key counts verified": countsChecked,
});
