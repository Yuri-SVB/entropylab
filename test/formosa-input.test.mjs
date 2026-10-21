// Typing a Formosa phrase: candidates and live analysis.
//
// Security contract
// -----------------
// candidates  What may be typed at one position. Unrestricted position, or a
//             restricted one whose leader is not yet typed: its whole list,
//             reported as unconstrained. Restricted position whose leader is
//             typed and real: exactly the words that leader allows, reported
//             as constrained. Offering a word the leader forbids would invite
//             a phrase the decoder must then refuse.
// analyze     Describes a phrase in progress without ever guessing: it names
//             every word absent from its position's list, every word its
//             leader forbids, and whether the count is a Formosa length. It
//             calls a phrase complete only at a supported length, and the
//             checksum verdict is formosaDecode's, not a second opinion.
//
// Expected values are read from the theme data and the reference vectors —
// a word taken from a leader's own row is accepted, a word taken from outside
// it is refused — never from running the functions under test.
//
// The prefix test is the one that justifies typing these phrases at all: two
// characters identify a word in every candidate set either theme can present,
// across all 835 restricted rows. It is a property of the data, so it is
// asserted over the data rather than sampled.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { formosaCandidates, formosaAnalyze, formosaDecode, formosaPartialBits } from "../src/js/formosa.js";
import { formosaThemes } from "../src/js/formosa-themes.js";

const root = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(root, "fixtures/formosa-vectors.json"), "utf8"));
const THEMES = ["global", "medieval_fantasy"];
const phraseOf = (theme, bits = 128) => vectors.themes[theme].find((entry) => entry.bits === bits).phrase.split(" ");
const wordsOf = (theme, position) => (typeof theme.words[position] === "string" ? theme.words[theme.words[position]] : theme.words[position]);

test("an unrestricted position offers its whole list, unconstrained", () => {
  for (const name of THEMES) {
    const data = formosaThemes[name];
    data.natural.forEach((position, at) => {
      if (data.ledBy[data.filling.indexOf(position)] !== null) return;
      const got = formosaCandidates([], at, name);
      assert.equal(got.position, position, `${name}: position ${at}`);
      assert.equal(got.constrained, false, `${name}: ${position} reported as constrained`);
      assert.deepEqual(got.words, wordsOf(data, position), `${name}: ${position} does not offer its list`);
    });
  }
});

test("a restricted position offers exactly what its leader allows", () => {
  const name = "medieval_fantasy";
  const data = formosaThemes[name];
  const words = phraseOf(name);
  data.natural.forEach((position, at) => {
    const index = data.filling.indexOf(position);
    const lead = data.ledBy[index];
    if (lead === null) return;
    const leadAt = data.natural.indexOf(lead);
    const list = wordsOf(data, position);
    const leadIndex = wordsOf(data, lead).indexOf(words[leadAt]);
    assert.ok(leadIndex >= 0, `${name}: the vector's ${lead} is not in its list`);
    const allowed = data.mapping[`${lead}>${position}`][leadIndex].map((pick) => list[pick]);

    const got = formosaCandidates(words, at, name);
    assert.equal(got.constrained, true, `${name}: ${position} is led by ${lead} but reported unconstrained`);
    assert.deepEqual(got.words, allowed, `${name}: ${position} does not offer ${lead}'s row`);
    assert.equal(got.words.length, 2 ** data.bits[index], `${name}: ${position} offers a row of the wrong width`);
  });
});

test("a restricted position falls back to its whole list until its leader is readable", () => {
  // Two of medieval_fantasy's positions are led by a word that comes LATER in
  // the sentence as it is typed, so left to right their leader is unknown.
  const name = "medieval_fantasy";
  const data = formosaThemes[name];
  const words = phraseOf(name);
  for (const position of ["SUBJECT", "ADJECTIVE"]) {
    const at = data.natural.indexOf(position);
    const lead = data.ledBy[data.filling.indexOf(position)];
    assert.ok(data.natural.indexOf(lead) > at, `${name}: ${position}'s leader no longer comes later`);
    const typed = words.slice(0, at);
    const got = formosaCandidates(typed, at, name);
    assert.equal(got.constrained, false, `${name}: ${position} claims a constraint it cannot know yet`);
    assert.deepEqual(got.words, wordsOf(data, position), `${name}: ${position} does not fall back to its list`);
  }
  // A leader that is typed but not a real word is no leader either.
  const at = data.natural.indexOf("OBJECT");
  const broken = [...words];
  broken[data.natural.indexOf("SUBJECT")] = "notaformosawordatall";
  assert.equal(formosaCandidates(broken, at, name).constrained, false, `${name}: an unreadable leader was treated as a constraint`);
});

const shortestUnique = (set) => {
  let n = 1;
  while (n < 32 && new Set(set.map((word) => word.slice(0, n))).size !== set.length) n++;
  return n;
};

test("two characters identify a word inside any leader's row", () => {
  // This is what makes a restricted theme typable: once the leader is known,
  // the set is 32 or 64 words and two characters separate them. It holds for
  // every row of every mapping, so it is asserted over all of them.
  let rows = 0;
  for (const name of THEMES) {
    const data = formosaThemes[name];
    for (const key of Object.keys(data.mapping)) {
      const list = wordsOf(data, key.split(">")[1]);
      for (const row of data.mapping[key]) {
        rows++;
        assert.equal(shortestUnique(row.map((pick) => list[pick])), 2, `${name}: ${key} has a row where two characters do not separate the words`);
      }
    }
  }
  assert.equal(rows, 835, "the number of rows changed; re-read the claim before trusting it");
});

test("an unconstrained list needs as many characters as it needs", () => {
  // The fallback sets are NOT two-character unique, and the interface must
  // say so rather than accept an ambiguous prefix. These are the real numbers
  // a typist meets: global is uniform, medieval_fantasy is not.
  const expected = {
    global: { ORIGIN1: 2, PROFESSION1: 2, ORIGIN2: 2, PROFESSION2: 2, WILDCARD: 2, PLACE: 2 },
    medieval_fantasy: { VERB: 2, SUBJECT: 6, OBJECT: 9, ADJECTIVE: 5, WILDCARD: 6, PLACE: 6 },
  };
  for (const name of THEMES) {
    const data = formosaThemes[name];
    for (const position of data.filling) {
      assert.equal(shortestUnique(wordsOf(data, position)), expected[name][position], `${name}: ${position}`);
    }
  }
});

test("analyze names every word that is not in its position's list", () => {
  for (const name of THEMES) {
    const data = formosaThemes[name];
    const words = phraseOf(name);
    for (const at of [0, 3, 11, 23]) {
      const broken = [...words];
      broken[at] = "notaformosawordatall";
      const report = formosaAnalyze(broken, name);
      assert.deepEqual(report.invalid.map((entry) => entry.at), [at], `${name}: word ${at} not reported`);
      assert.equal(report.invalid[0].word, "notaformosawordatall");
      assert.equal(report.invalid[0].position, data.natural[at % data.natural.length], `${name}: word ${at} blamed on the wrong position`);
      assert.equal(report.complete, false, `${name}: a phrase with an unknown word was called complete`);
    }
  }
});

test("analyze names a word its leader forbids, and the leader that forbids it", () => {
  const name = "medieval_fantasy";
  const data = formosaThemes[name];
  const words = phraseOf(name);
  // OBJECT is led by SUBJECT, which is typed before it, so the constraint is
  // live. Take a word from OBJECT's list that this SUBJECT does not allow.
  const at = data.natural.indexOf("OBJECT");
  const leadAt = data.natural.indexOf("SUBJECT");
  const list = wordsOf(data, "OBJECT");
  const leadIndex = wordsOf(data, "SUBJECT").indexOf(words[leadAt]);
  const allowed = new Set(data.mapping["SUBJECT>OBJECT"][leadIndex].map((pick) => list[pick]));
  const forbidden = list.find((word) => !allowed.has(word));
  assert.ok(forbidden, "fixture: this SUBJECT allows every OBJECT, so there is nothing to refuse");

  const broken = [...words];
  broken[at] = forbidden;
  const report = formosaAnalyze(broken, name);
  assert.deepEqual(report.invalid, [], "a word on the list was reported as unknown");
  assert.equal(report.forbidden.length, 1, "the forbidden word was not reported exactly once");
  assert.equal(report.forbidden[0].at, at);
  assert.equal(report.forbidden[0].word, forbidden);
  assert.equal(report.forbidden[0].lead, "SUBJECT");
  assert.equal(report.forbidden[0].leadWord, words[leadAt]);
  assert.equal(report.complete, false, "a phrase with a forbidden word was called complete");
});

test("analyze calls a phrase complete only at a Formosa length", () => {
  for (const name of THEMES) {
    const full = phraseOf(name, 256);
    assert.equal(full.length, 48, "fixture: the 256-bit phrase is 48 words");
    for (const count of [0, 1, 6, 12, 18, 23, 25, 47]) {
      assert.equal(formosaAnalyze(full.slice(0, count), name).complete, false, `${name}: ${count} words called complete`);
    }
    for (const count of [24, 30, 36, 42, 48]) {
      const report = formosaAnalyze(full.slice(0, count), name);
      assert.equal(report.count, count, `${name}: ${count} words miscounted`);
      // A prefix of a longer phrase is well formed but its checksum is its
      // own; completeness is about length, the verdict is the decoder's.
      assert.equal(report.complete, true, `${name}: ${count} words not called complete`);
      assert.equal(report.checksumOk, formosaDecode(full.slice(0, count), name).ok, `${name}: ${count} words disagrees with the decoder`);
    }
  }
});

test("analyze returns the entropy the decoder returns, and only when it agrees", () => {
  for (const name of THEMES) {
    for (const entry of vectors.themes[name]) {
      const report = formosaAnalyze(entry.phrase.split(" "), name);
      assert.equal(report.checksumOk, true, `${name} ${entry.bits}-bit: refused a reference phrase`);
      assert.equal(Buffer.from(report.entropy).toString("hex"), entry.entropy, `${name} ${entry.bits}-bit`);
    }
    // A phrase whose checksum is wrong yields no entropy at all. The swap is
    // taken from what the final position's leader allows, so the phrase stays
    // well formed and the only thing left to fail is the checksum.
    const words = phraseOf(name);
    const data = formosaThemes[name];
    const at = words.length - 1;
    const allowed = formosaCandidates(words, at, name).words;
    const swap = allowed.find((word) => word !== words[at] && !formosaDecode([...words.slice(0, at), word], name).ok);
    assert.ok(swap, `${name}: no substitution the decoder refuses, so the checksum is not checked`);
    const report = formosaAnalyze([...words.slice(0, at), swap], name);
    assert.deepEqual([report.invalid, report.forbidden], [[], []], `${name}: a well-formed phrase was reported malformed`);
    assert.equal(report.complete, true, `${name}: a full-length phrase was not called complete`);
    assert.equal(report.checksumOk, false, `${name}: a wrong checksum was accepted`);
    assert.equal(report.entropy, null, `${name}: entropy handed back for a phrase the decoder refused`);
  }
});

// The bit stream a phrase stands for: the entropy followed by the BIP-39
// checksum bits. Built here from the vector's own entropy with node's crypto,
// so it owes nothing to src/js/formosa.js.
function expectedBits(hex) {
  const bytes = Buffer.from(hex, "hex");
  const bits = [...bytes].map((byte) => byte.toString(2).padStart(8, "0")).join("");
  const digest = [...createHash("sha256").update(bytes).digest()].map((byte) => byte.toString(2).padStart(8, "0")).join("");
  return bits + digest.slice(0, bits.length / 32);
}

test("a half-typed phrase reads out the sentences that are finished", () => {
  for (const name of THEMES) {
    const data = formosaThemes[name];
    const perPhrase = data.natural.length;
    for (const entry of vectors.themes[name]) {
      const words = entry.phrase.split(" ");
      const whole = expectedBits(entry.entropy);
      assert.equal(formosaPartialBits(words, name), whole, `${name} ${entry.bits}-bit: the whole phrase`);
      // Every sentence boundary, and every point in between: a sentence that
      // is not finished contributes nothing.
      for (let at = 0; at <= words.length; at++) {
        const settled = Math.floor(at / perPhrase) * 33;
        assert.equal(formosaPartialBits(words.slice(0, at), name), whole.slice(0, settled), `${name} ${entry.bits}-bit: ${at} words`);
      }
    }
  }
});

test("a half-typed phrase stops at the first sentence that is wrong", () => {
  for (const name of THEMES) {
    const data = formosaThemes[name];
    const perPhrase = data.natural.length;
    const entry = vectors.themes[name].find((v) => v.bits === 256);
    const words = entry.phrase.split(" ");
    const whole = expectedBits(entry.entropy);
    // An unknown word in the third sentence leaves the first two standing.
    const broken = [...words];
    broken[perPhrase * 2] = "notaformosawordatall";
    assert.equal(formosaPartialBits(broken, name), whole.slice(0, 2 * 33), `${name}: an unknown word did not stop the read`);
    assert.equal(formosaPartialBits(["notaformosawordatall", ...words.slice(1)], name), "", `${name}: a bad first sentence still published bits`);
  }
});

test("a half-typed phrase stops at a word its leader forbids", () => {
  const name = "medieval_fantasy";
  const data = formosaThemes[name];
  const perPhrase = data.natural.length;
  const entry = vectors.themes[name].find((v) => v.bits === 256);
  const words = entry.phrase.split(" ");
  const whole = expectedBits(entry.entropy);
  // OBJECT in the second sentence, whose leader SUBJECT is typed before it.
  const at = perPhrase + data.natural.indexOf("OBJECT");
  const allowed = new Set(formosaCandidates(words, at, name).words);
  const forbidden = wordsOf(data, "OBJECT").find((word) => !allowed.has(word));
  assert.ok(forbidden, "fixture: this SUBJECT allows every OBJECT");
  const broken = [...words];
  broken[at] = forbidden;
  assert.equal(formosaPartialBits(broken, name), whole.slice(0, 33), "a forbidden word did not stop the read");
});
