#!/usr/bin/env node
// Generates keys.json from the assessment's HidKeyCodes.md reference table.
//
// The catalog is the single source of truth for both API implementations:
// the TypeScript Lambda imports keys.json directly, and the .NET project
// embeds the same file as a compiled resource. Regenerate with:
//
//   npm run generate -w @apex/hid-catalog
//
// A drift test in each API asserts the catalog it sees matches this output.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourceDoc = join(here, "..", "..", "HidKeyCodes.md");
const outFile = join(here, "keys.json");
const outModule = join(here, "src", "catalog.generated.ts");

const markdown = readFileSync(sourceDoc, "utf8");

// The doc is a series of `## Category` headings, each followed by a markdown
// table whose first column is the key name and second is the hex HID code.
const ROW = /^\|\s*([^|]+?)\s*\|\s*(0x[0-9A-Fa-f]{2})\s*\|\s*(\d+)\s*\|/;

const keys = [];
let category = null;

for (const line of markdown.split("\n")) {
  const heading = /^##\s+(.+?)\s*$/.exec(line);
  if (heading) {
    category = heading[1];
    continue;
  }

  const row = ROW.exec(line.trim());
  if (!row || !category) continue;

  const [, rawName, hex, dec] = row;
  const hidCode = Number.parseInt(hex, 16);

  if (hidCode !== Number.parseInt(dec, 10)) {
    throw new Error(`${rawName}: hex ${hex} and decimal ${dec} disagree in HidKeyCodes.md`);
  }
  if (hidCode < 0x00 || hidCode > 0xff) {
    throw new Error(`${rawName}: HID code ${hex} is outside the 8-bit range`);
  }

  keys.push({
    hidCode,
    hidCodeHex: `0x${hidCode.toString(16).toUpperCase().padStart(2, "0")}`,
    name: rawName.replace(/\s*\(Win\/Cmd\)\s*/, " (Win/Cmd)").trim(),
    category: normalizeCategory(category),
  });
}

function normalizeCategory(raw) {
  // "Numbers (Top Row)" -> "Numbers", "Special / Editing Keys" -> "Special"
  if (raw.startsWith("Numbers")) return "Numbers";
  if (raw.startsWith("Special")) return "Special";
  if (raw.startsWith("Function")) return "Function";
  if (raw.startsWith("Arrow")) return "Arrows";
  if (raw.startsWith("Modifier")) return "Modifiers";
  return raw;
}

if (keys.length === 0) {
  throw new Error("Parsed no keys from HidKeyCodes.md — did the table format change?");
}

const seen = new Map();
for (const key of keys) {
  if (seen.has(key.hidCode)) {
    throw new Error(`Duplicate HID code ${key.hidCodeHex}: ${seen.get(key.hidCode)} and ${key.name}`);
  }
  seen.set(key.hidCode, key.name);
}

keys.sort((a, b) => a.hidCode - b.hidCode);

const catalog = {
  $generatedFrom: "HidKeyCodes.md",
  $generator: "packages/hid-catalog/generate.mjs",
  keyboards: [
    {
      // Slug is what callers put in the URL; name is the human label the
      // assessment specifies ("Apex Pro Gen 3").
      slug: "apex-pro-gen-3",
      name: "Apex Pro Gen 3",
      vendor: "SteelSeries",
      keys,
    },
  ],
};

writeFileSync(outFile, `${JSON.stringify(catalog, null, 2)}\n`);

// Also emit the catalog as a TypeScript module. Importing a .ts module rather
// than the .json keeps behaviour identical across tsc, esbuild, vite and
// vitest, none of which agree on JSON import attributes and asset copying.
// `catalog.drift.test.ts` asserts this module and keys.json stay in step.
writeFileSync(
  outModule,
  [
    "// GENERATED FILE — do not edit by hand.",
    "// Source: HidKeyCodes.md via packages/hid-catalog/generate.mjs",
    '// Regenerate with: npm run catalog:generate',
    "",
    'import type { Catalog } from "./types.js";',
    "",
    `export const generatedCatalog: Catalog = ${JSON.stringify({ keyboards: catalog.keyboards }, null, 2)} as const;`,
    "",
  ].join("\n"),
);

const byCategory = keys.reduce((acc, k) => ({ ...acc, [k.category]: (acc[k.category] ?? 0) + 1 }), {});
console.log(`Wrote ${keys.length} keys to:\n  ${outFile}\n  ${outModule}`);
console.table(byCategory);
