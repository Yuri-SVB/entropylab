// The vendored Formosa (BIP-450) theme data.
//
// Security contract
// -----------------
// src/js/formosa-themes.js is 150 KB of word lists and index matrices that
// nobody reads in a diff, and a wrong index there is a wrong seed. Its header
// records what it came from — the Formosa commit, each theme file's git blob
// hash — and a sha256 over the data itself. This file turns those three
// records from comments into pins:
//
//   accepted  data whose own sha256 is the one its header records, whose
//             provenance matches the fixture the vectors came from, and whose
//             shape can carry 33 bits per sentence with nothing left over.
//   refused   any other data, whether a hand edit, a bad merge, or a
//             regeneration from a source the fixture was not built against.
//
// Why this is not already covered: the 50 reference vectors in
// formosa-codec exercise at most a few hundred sentences, while
// medieval_fantasy's matrices alone hold 40,864 indices. A corrupted index in
// a row no vector visits reproduces every phrase and still mints a wrong seed
// for the person who hits that row. The digest sees it; the vectors cannot.
//
// The two checks divide the work: the digest pins the file against edits, the
// structural assertions pin it against bad input — a regeneration that
// recomputes its own digest from corrupted upstream data passes the first and
// fails the second. Both are cheap and neither needs a Formosa checkout.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formosaThemes } from "../src/js/formosa-themes.js";

const root = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(root, "../src/js/formosa-themes.js"), "utf8");
const vectors = JSON.parse(readFileSync(join(root, "fixtures/formosa-vectors.json"), "utf8"));
const THEMES = ["global", "medieval_fantasy"];
const PHRASE_BITS = 33;

// A position either owns its word list or names the position that owns it.
const wordsOf = (theme, position) => (typeof theme.words[position] === "string" ? theme.words[theme.words[position]] : theme.words[position]);

// The header is this file's own output, so its shape is ours to rely on; the
// recorded count is asserted below so a format change cannot pass silently as
// "nothing to check".
function header() {
  const out = { commit: source.match(/^\/\/ Source: Formosa at commit ([0-9a-f]{40})$/m)?.[1], themes: {} };
  let current = null;
  for (const line of source.split("\n")) {
    const named = line.match(/^\/\/\s+(\w+)\.json\s+blob\s+([0-9a-f]{40})\s*$/);
    if (named) {
      current = named[1];
      out.themes[current] = { blob: named[2] };
      continue;
    }
    const digest = line.match(/^\/\/\s+data sha256 ([0-9a-f]{64})\s*$/);
    if (digest && current) out.themes[current].digest = digest[1];
  }
  return out;
}

test("the header records a provenance and a digest for every theme", () => {
  const recorded = header();
  assert.match(recorded.commit ?? "", /^[0-9a-f]{40}$/, "the header names no Formosa commit");
  assert.deepEqual(Object.keys(recorded.themes).sort(), [...THEMES].sort(), "the header does not cover exactly the shipped themes");
  for (const name of THEMES) {
    assert.match(recorded.themes[name].blob ?? "", /^[0-9a-f]{40}$/, `${name}: no blob hash`);
    assert.match(recorded.themes[name].digest ?? "", /^[0-9a-f]{64}$/, `${name}: no data digest`);
  }
  assert.deepEqual(Object.keys(formosaThemes).sort(), [...THEMES].sort());
});

test("each theme's data is the data its header's digest describes", () => {
  const recorded = header();
  for (const name of THEMES) {
    const theme = formosaThemes[name];
    // The generator digests the data before aliasing, so resolve the aliases
    // back to the lists they name before hashing.
    const words = Object.fromEntries(theme.filling.map((position) => [position, wordsOf(theme, position)]));
    const digest = createHash("sha256")
      .update(JSON.stringify({ filling: theme.filling, natural: theme.natural, bits: theme.bits, ledBy: theme.ledBy, words, mapping: theme.mapping }))
      .digest("hex");
    assert.equal(digest, recorded.themes[name].digest, `${name}: the data is not what the header records — regenerate, or revert the edit`);
  }
});

test("the vectors were built against the data that is shipped", () => {
  const recorded = header();
  assert.equal(vectors.provenance.commit, recorded.commit, "the fixture and the theme data name different Formosa commits");
  for (const name of THEMES) {
    assert.equal(vectors.provenance.theme_blobs[name], recorded.themes[name].blob, `${name}: the fixture was built against a different theme file`);
  }
});

test("a sentence addresses every position exactly, with no bits left over", () => {
  for (const name of THEMES) {
    const theme = formosaThemes[name];
    assert.equal(theme.bits.reduce((sum, width) => sum + width, 0), PHRASE_BITS, `${name}: a sentence does not carry ${PHRASE_BITS} bits`);
    assert.deepEqual([...theme.natural].sort(), [...theme.filling].sort(), `${name}: the natural and filling orders are not the same positions`);
    assert.equal(new Set(theme.filling).size, theme.filling.length, `${name}: a position appears twice in the filling order`);
    theme.filling.forEach((position, index) => {
      const lead = theme.ledBy[index];
      const choices = 2 ** theme.bits[index];
      if (lead === null) {
        assert.equal(wordsOf(theme, position).length, choices, `${name}: ${position} does not hold exactly ${choices} words`);
        return;
      }
      assert.ok(theme.filling.includes(lead), `${name}: ${position} is led by ${lead}, which is not a position`);
      const rows = theme.mapping[`${lead}>${position}`];
      assert.ok(Array.isArray(rows), `${name}: ${lead}>${position} has no matrix`);
      assert.equal(rows.length, wordsOf(theme, lead).length, `${name}: ${lead}>${position} has a row count its leader's list cannot index`);
      const list = wordsOf(theme, position);
      rows.forEach((row, at) => {
        assert.equal(row.length, choices, `${name}: ${lead}>${position} row ${at} is ${row.length} wide, not ${choices}`);
        assert.ok(row.every((index2) => Number.isInteger(index2) && index2 >= 0 && index2 < list.length), `${name}: ${lead}>${position} row ${at} indexes outside ${position}`);
        // A row that offers one word twice gives two bit patterns the same
        // sentence, and decode resolves such a word to the first of them, so
        // the other pattern could never be typed back.
        assert.equal(new Set(row).size, row.length, `${name}: ${lead}>${position} row ${at} offers a word twice`);
      });
    });
  }
});

test("no position offers the same word twice", () => {
  // decode resolves a word by indexOf, so a duplicate would make two bit
  // patterns share a phrase: one of them could never be typed back.
  for (const name of THEMES) {
    const theme = formosaThemes[name];
    for (const position of theme.filling) {
      const list = wordsOf(theme, position);
      assert.ok(Array.isArray(list) && list.length > 0, `${name}: ${position} resolves to no word list`);
      assert.equal(new Set(list).size, list.length, `${name}: ${position} offers a word twice`);
    }
  }
});
