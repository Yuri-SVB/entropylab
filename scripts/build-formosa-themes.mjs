#!/usr/bin/env node
// Packs Formosa (BIP-450) theme files into src/js/formosa-themes.js.
//
// Maintainer tool, run by hand, deliberately NOT part of `npm run build` or of
// CI: it needs a Formosa checkout, which this repository does not depend on.
// The committed module is the artifact. Its header records the Formosa commit,
// each theme file's blob hash and a sha256 over the packed data;
// test/formosa-themes.test.mjs recomputes that digest from what is committed,
// so a regeneration shows up as a changed digest in the diff and a hand edit
// fails the suite.
//
//   node scripts/build-formosa-themes.mjs --formosa ../formosa
//
// Formosa is https://github.com/yuri-svb/formosa. The header below records
// the commit and each theme file's blob hash, so a reviewer can fetch that
// commit and check the two hashes without trusting this file.
//
// Upstream stores each restricted mapping as whole words — for medieval_fantasy
// that is 40,864 word copies and a 1.3 MB file. The same information is the
// index of each word in the led position's list, which fits a byte. Those
// indices are written here as plain rows of numbers rather than a base64 blob:
// a blob cannot be read in a diff, and measured on this data it is also larger
// delivered, 15.3 KB gzipped against 11.4 KB, because base64 destroys the
// redundancy the compressor would otherwise find.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const THEMES = ["global", "medieval_fantasy"];

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const formosa = resolve(arg("formosa", join(root, "..", "formosa")));

function readTheme(name) {
  const path = join(formosa, "src/mnemonic/themes", `${name}.json`);
  const raw = readFileSync(path, "utf8");
  const data = JSON.parse(raw);
  let blob = "";
  try {
    blob = execFileSync("git", ["hash-object", path], { cwd: formosa, encoding: "utf8" }).trim();
  } catch {
    blob = "(not a git checkout)";
  }
  return { data, blob };
}

function pack(name) {
  const { data, blob } = readTheme(name);
  const filling = data.FILLING_ORDER;
  const natural = data.NATURAL_ORDER;
  const bits = filling.map((position) => data[position].BIT_LENGTH);
  const ledBy = filling.map((position) => (data[position].LED_BY === "NONE" ? null : data[position].LED_BY));
  const words = Object.fromEntries(filling.map((position) => [position, data[position].TOTAL_LIST]));

  // Every position offers exactly 2**BIT_LENGTH choices once its leader is
  // fixed, so a bit slice indexes the row directly with nothing left over.
  const mapping = {};
  for (const lead of filling) {
    for (const led of data[lead].LEADS || []) {
      const table = data[lead][led].MAPPING;
      const keys = Object.keys(table);
      assert(keys.length === words[lead].length && keys.every((key, at) => key === words[lead][at]),
        `${name}: ${lead}->${led} rows are not the leader's word list in order`);
      const index = new Map(words[led].map((word, at) => [word, at]));
      const width = 2 ** bits[filling.indexOf(led)];
      const rows = keys.map((key) => {
        const row = table[key].map((word) => {
          const at = index.get(word);
          assert(at !== undefined, `${name}: ${lead}->${led} maps "${word}", absent from ${led}`);
          return at;
        });
        assert(row.length === width, `${name}: ${lead}->${led} row for "${key}" is ${row.length} wide, expected ${width}`);
        assert(row.every((at) => at < 256), `${name}: ${lead}->${led} index does not fit a byte`);
        return row;
      });
      mapping[`${lead}>${led}`] = rows;
    }
  }

  // Unrestricted positions must still offer exactly 2**BIT_LENGTH words, or a
  // bit slice would address a word that is not there.
  filling.forEach((position, at) => {
    if (ledBy[at] === null) {
      assert(words[position].length === 2 ** bits[at],
        `${name}: ${position} holds ${words[position].length} words, expected ${2 ** bits[at]}`);
    }
  });

  const digest = createHash("sha256")
    .update(JSON.stringify({ filling, natural, bits, ledBy, words, mapping }))
    .digest("hex");

  return { name, filling, natural, bits, ledBy, words, mapping, blob, digest };
}

function assert(condition, message) {
  if (!condition) {
    console.error(`refusing to write: ${message}`);
    process.exit(1);
  }
}

function emitWords(words, filling) {
  // Positions that share a list (global's two ORIGIN and two PROFESSION slots)
  // name the first one instead of repeating several kilobytes of words.
  const seen = new Map();
  const lines = [];
  for (const position of filling) {
    const key = words[position].join("\n");
    if (seen.has(key)) {
      // An alias is the owner's name, not a comment: a reader of this data must
      // be able to resolve it without knowing which positions happen to share.
      lines.push(`      ${position}: ${JSON.stringify(seen.get(key))},`);
      continue;
    }
    seen.set(key, position);
    lines.push(`      ${position}: \`${key}\`.split("\\n"),`);
  }
  return lines.join("\n");
}

function emitMapping(mapping) {
  const names = Object.keys(mapping);
  if (!names.length) return "    mapping: {},";
  const blocks = names.map((name) => {
    const rows = mapping[name].map((row) => `        [${row.join(",")}],`).join("\n");
    return `      "${name}": [\n${rows}\n      ],`;
  });
  return `    mapping: {\n${blocks.join("\n")}\n    },`;
}

const packed = THEMES.map(pack);
let commit = "(unknown)";
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: formosa, encoding: "utf8" }).trim();
} catch { /* not a checkout */ }

const header = `// Formosa (BIP-450) theme data, packed from the reference implementation.
//
// Generated by scripts/build-formosa-themes.mjs — do not edit by hand.
// Source: Formosa at commit ${commit}
${packed.map((theme) => `//   ${theme.name}.json  blob ${theme.blob}\n//   ${" ".repeat(theme.name.length)}       data sha256 ${theme.digest}`).join("\n")}
//
// Each theme carries its filling order (the order bit slices are consumed),
// its natural order (the order words are shown and typed), the bit width of
// each position, which position leads each other, the word list of every
// position, and for a restricted theme the index matrices. A matrix row holds
// the indices into the led position's list that its leader allows, and rows
// are in the leader's own word order, so a leader's index selects the row.
//
// Regenerate and compare rather than trusting these digests:
//   node scripts/build-formosa-themes.mjs --formosa <path-to-formosa>
//   git diff --stat src/js/formosa-themes.js
`;

const body = packed.map((theme) => `  ${theme.name}: Object.freeze({
    filling: ${JSON.stringify(theme.filling)},
    natural: ${JSON.stringify(theme.natural)},
    bits: ${JSON.stringify(theme.bits)},
    ledBy: ${JSON.stringify(theme.ledBy)},
    words: {
${emitWords(theme.words, theme.filling)}
    },
${emitMapping(theme.mapping)}
  }),`).join("\n");

writeFileSync(join(root, "src/js/formosa-themes.js"),
  `${header}\nexport const formosaThemes = /* @__PURE__ */ Object.freeze({\n${body}\n});\n`);

for (const theme of packed) {
  const indices = Object.values(theme.mapping).reduce((sum, rows) => sum + rows.length * rows[0].length, 0);
  console.log(`${theme.name.padEnd(17)} ${theme.filling.length} positions, ${theme.bits.reduce((a, b) => a + b, 0)} bits/phrase, ` +
    `${Object.values(theme.words).reduce((sum, list) => sum + list.length, 0)} words, ${indices} indices`);
  console.log(`${" ".repeat(17)} sha256 ${theme.digest}`);
}
console.log(`wrote src/js/formosa-themes.js`);
