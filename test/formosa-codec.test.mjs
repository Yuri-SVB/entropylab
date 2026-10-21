// Formosa (BIP-450) encoding and decoding.
//
// Security contract
// -----------------
// encode   Entropy of a supported BIP-39 size becomes a word list: the entropy
//          plus its BIP-39 checksum, cut into 33-bit segments, each segment
//          consumed in the theme's FILLING order and the words shown in its
//          NATURAL order. Accepted: 16, 20, 24, 28 and 32 bytes. Refused:
//          any other length, and an unknown theme.
// decode   The inverse, and it must REFUSE rather than guess: a wrong word
//          count, a word absent from its position's list, a word its leader
//          does not allow in a restricted theme, and a phrase whose checksum
//          does not match. Entropy in, phrase out, same entropy back.
//
// Expected values come from test/fixtures/formosa-vectors.json, produced by the
// Formosa Python reference at a pinned commit, which has never seen this
// implementation. There are no published Formosa-theme vectors: upstream's
// vectors.json carries only the BIP39 theme. The fixture records the reference
// commit and both theme blob hashes, so drift against upstream is detectable.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formosaEncode, formosaDecode, formosaWordCount } from "../src/js/formosa.js";
import { formosaThemes } from "../src/js/formosa-themes.js";

const root = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(root, "fixtures/formosa-vectors.json"), "utf8"));
const THEMES = Object.keys(vectors.themes);
const bytes = (hex) => Uint8Array.from(Buffer.from(hex, "hex"));

test("the fixture is the reference's own output, not this implementation's", () => {
  assert.match(vectors.provenance.source, /reference implementation/);
  assert.match(vectors.provenance.commit, /^[0-9a-f]{40}$/);
  for (const theme of THEMES) assert.match(vectors.provenance.theme_blobs[theme], /^[0-9a-f]{40}$/);
  assert.deepEqual(THEMES.sort(), ["global", "medieval_fantasy"]);
  assert.equal(vectors.themes.global.length, 25);
  assert.equal(vectors.themes.medieval_fantasy.length, 25);
});

test("encoding reproduces every reference phrase", () => {
  for (const theme of THEMES) {
    for (const v of vectors.themes[theme]) {
      const got = formosaEncode(bytes(v.entropy), theme);
      assert.equal(got.words.join(" "), v.phrase, `${theme} ${v.bits}-bit ${v.pattern}`);
    }
  }
});

test("a phrase is six words per 33 bits, exact at every supported size", () => {
  const expected = { 128: 24, 160: 30, 192: 36, 224: 42, 256: 48 };
  for (const [bits, words] of Object.entries(expected)) {
    assert.equal(formosaWordCount(Number(bits)), words, `${bits}-bit`);
  }
  for (const theme of THEMES) {
    for (const v of vectors.themes[theme]) {
      assert.equal(formosaEncode(bytes(v.entropy), theme).words.length, expected[v.bits], `${theme} ${v.bits}-bit`);
      assert.equal(v.words, expected[v.bits], "fixture: word count disagrees with the reference");
    }
  }
});

test("decoding every reference phrase returns the entropy it was made from", () => {
  for (const theme of THEMES) {
    for (const v of vectors.themes[theme]) {
      const got = formosaDecode(v.phrase.split(" "), theme);
      assert.equal(got.ok, true, `${theme} ${v.bits}-bit ${v.pattern}: refused a reference phrase`);
      assert.equal(Buffer.from(got.entropy).toString("hex"), v.entropy, `${theme} ${v.bits}-bit ${v.pattern}`);
    }
  }
});

test("encode refuses an entropy length BIP-39 does not define", () => {
  for (const theme of THEMES) {
    for (const length of [0, 1, 15, 17, 31, 33, 64]) {
      assert.throws(() => formosaEncode(new Uint8Array(length), theme), /length/i, `${theme}: ${length} bytes accepted`);
    }
    assert.throws(() => formosaEncode(new Uint8Array(16), "no_such_theme"), /theme/i);
  }
});

test("decode refuses a phrase of the wrong length", () => {
  for (const theme of THEMES) {
    const full = vectors.themes[theme].find((v) => v.bits === 128).phrase.split(" ");
    assert.equal(full.length, 24, "fixture: the 128-bit phrase is 24 words");
    // Short of a sentence boundary, past one, and a whole number of sentences
    // that is not a BIP-39 entropy size. Slicing alone cannot lengthen a list,
    // so the long cases repeat words to reach the count.
    const atLength = (count) => Array.from({ length: count }, (unused, at) => full[at % full.length]);
    for (const count of [0, 1, 5, 23, 25, 29, 6, 12, 18, 54]) {
      const result = formosaDecode(atLength(count), theme);
      assert.equal(result.ok, false, `${theme}: ${count} words accepted`);
    }
  }
});

test("decode refuses a word that is not in its position's list", () => {
  for (const theme of THEMES) {
    const words = vectors.themes[theme].find((v) => v.bits === 128).phrase.split(" ");
    for (const at of [0, 3, 11, 23]) {
      const broken = [...words];
      broken[at] = "notaformosawordatall";
      const result = formosaDecode(broken, theme);
      assert.equal(result.ok, false, `${theme}: unknown word at ${at} accepted`);
    }
  }
});

test("decode refuses a word its leader does not allow", () => {
  // Only a restricted theme can have this failure: in an unrestricted theme
  // every word of a position is reachable from every leader.
  const theme = "medieval_fantasy";
  const words = vectors.themes[theme].find((v) => v.bits === 128).phrase.split(" ");
  const data = formosaThemes[theme];
  const ledAt = data.filling.findIndex((position, at) => data.ledBy[at] !== null);
  const led = data.filling[ledAt];
  const lead = data.ledBy[ledAt];
  const naturalAt = data.natural.indexOf(led);

  const list = resolveWords(data, led);
  const row = data.mapping[`${lead}>${led}`][0];
  const allowed = new Set(row.map((index) => list[index]));
  const forbidden = list.find((word) => !allowed.has(word));
  assert.ok(forbidden, "fixture: every word is allowed, so there is nothing to refuse");

  // Put the forbidden word in the first phrase, where row 0's leader sits only
  // if the first phrase chose it; so rebuild from a transcript we control.
  const broken = [...words];
  broken[naturalAt] = forbidden;
  const result = formosaDecode(broken, theme);
  if (result.ok) {
    // The swap may coincidentally be allowed by whichever leader this phrase
    // actually has. Then the swapped word must still decode to a real index,
    // and a word forbidden by THAT leader must be refused.
    const leadNaturalAt = data.natural.indexOf(lead);
    const leadIndex = resolveWords(data, lead).indexOf(words[leadNaturalAt]);
    const realRow = data.mapping[`${lead}>${led}`][leadIndex];
    const realAllowed = new Set(realRow.map((index) => list[index]));
    const reallyForbidden = list.find((word) => !realAllowed.has(word));
    assert.ok(reallyForbidden, "fixture: this leader allows every word");
    const broken2 = [...words];
    broken2[naturalAt] = reallyForbidden;
    assert.equal(formosaDecode(broken2, theme).ok, false, "a word the leader forbids was accepted");
  }
});

test("decode refuses a phrase whose checksum does not match", () => {
  for (const theme of THEMES) {
    const data = formosaThemes[theme];
    const v = vectors.themes[theme].find((entry) => entry.bits === 128);
    const words = v.phrase.split(" ");
    // Change the LAST phrase's final position, which carries checksum bits.
    const lastPosition = data.natural[data.natural.length - 1];
    const at = words.length - data.natural.length + data.natural.indexOf(lastPosition);
    const list = resolveWords(data, lastPosition);
    let refused = 0;
    let tried = 0;
    for (const candidate of list) {
      if (candidate === words[at]) continue;
      const broken = [...words];
      broken[at] = candidate;
      const result = formosaDecode(broken, theme);
      tried++;
      if (!result.ok) refused++;
      else assert.notEqual(Buffer.from(result.entropy).toString("hex"), v.entropy, `${theme}: a different phrase gave the same entropy`);
    }
    assert.ok(tried > 0, `${theme}: nothing to try`);
    assert.ok(refused > 0, `${theme}: no substitution was refused, so the checksum is not checked`);
  }
});

test("every supported size round-trips through both directions", () => {
  for (const theme of THEMES) {
    for (const length of [16, 20, 24, 28, 32]) {
      const entropy = Uint8Array.from({ length }, (unused, at) => (at * 37 + 11) & 0xff);
      const encoded = formosaEncode(entropy, theme);
      const decoded = formosaDecode(encoded.words, theme);
      assert.equal(decoded.ok, true, `${theme} ${length} bytes: refused its own output`);
      assert.deepEqual(Array.from(decoded.entropy), Array.from(entropy), `${theme} ${length} bytes`);
    }
  }
});

function resolveWords(data, position) {
  const list = data.words[position];
  return typeof list === "string" ? data.words[list] : list;
}
