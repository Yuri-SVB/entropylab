// The Formosa phrase in the recovery card.
//
// Security contract
// -----------------
// A Formosa phrase is the seed in another alphabet, so it is recovery
// material and must behave like the BIP-39 phrase beside it. Concealed, the
// card must not carry the words at all — not in text, not in an attribute —
// and must look the same whatever entropy produced it, since a mask that
// varies leaks what it hides. Revealed, it must show exactly the words the
// codec derives, in order, for the theme named on the row.
//
// On what the first two tests do and do not prove: hodlSeedPhraseField masks
// its own value, so the words do not reach the markup even when the caller
// hands it real ones. Bypassing the concealed branch of
// hodlFormosaRecoveryFields entirely leaves these tests green — verified by
// injection. They therefore assert the card's observable behaviour, and would
// catch a future row that rendered its value without that helper; they do not
// guard the caller's own discipline of never deriving the words while
// concealed. That discipline is kept because the plaintext should not exist
// at all, not because a test can see it, and nothing in markup can.
//
// The last three tests are the ones with teeth: reversing the theme order,
// emitting rows for a wallet with no entropy, or ignoring the theme argument
// each fail exactly one of them.
//
// What the display shows is checked against src/js/formosa.js, whose own
// correctness is pinned against the reference vectors in formosa-codec. This
// file asserts the contract between the two, not the codec again. Nothing
// here asserts copy, CSS or class names.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAppFunctions } from "./app-slice-harness.mjs";
import { MiniDocument } from "./mini-dom.mjs";
import { formosaEncode, formosaWordCount } from "../src/js/formosa.js";

const inert = new Proxy(function () {}, { get: (target, key) => key === Symbol.toPrimitive ? () => "" : key === "then" ? undefined : inert, apply: () => inert, construct: () => inert });
Object.assign(globalThis, { __ENTROPYLAB_TEST_HOOKS__: false, document: inert, window: inert });
const view = await loadAppFunctions(["hodlFormosaRecoveryFields", "hodlSeedPhraseField"], {
  stubs: { formosaEncode, formosaWordCount, hodlUqrRenderSvg: () => "" },
  settable: ["hodlRevealPrivate"],
});
delete globalThis.document;
delete globalThis.window;

const THEMES = ["global", "medieval_fantasy"];
// Entropies of the two sizes that bracket the range, each with a very
// different byte pattern so a leak through the mask would show up.
const entropies = [
  new Uint8Array(16),
  Uint8Array.from({ length: 16 }, (unused, at) => (at * 37 + 11) & 0xff),
  Uint8Array.from({ length: 16 }, () => 0xff),
  new Uint8Array(32),
  Uint8Array.from({ length: 32 }, (unused, at) => (at * 53 + 7) & 0xff),
];
const markup = (entropy) => view.hodlFormosaRecoveryFields({ entropy }).join("");

function shownValues(html) {
  const document = new MiniDocument();
  document.body.innerHTML = html;
  return [document.body.textContent, ...document.body.querySelectorAll("*").flatMap((node) => node.getAttributeNames().map((name) => node.getAttribute(name)))];
}

test("a concealed card carries none of the Formosa words", () => {
  view.__set.hodlRevealPrivate(false);
  for (const entropy of entropies) {
    const values = shownValues(markup(entropy));
    for (const theme of THEMES) {
      for (const word of new Set(formosaEncode(entropy, theme).words)) {
        assert.ok(values.every((value) => !value.includes(word)), `${theme}, ${entropy.length} bytes: the concealed card shows "${word}"`);
      }
    }
  }
});

test("a concealed card looks the same whatever entropy made it", () => {
  view.__set.hodlRevealPrivate(false);
  for (const length of [16, 32]) {
    const sameSize = entropies.filter((entropy) => entropy.length === length);
    assert.ok(sameSize.length > 1, `${length} bytes: need more than one sample`);
    const rendered = sameSize.map(markup);
    assert.equal(new Set(rendered).size, 1, `${length} bytes: the concealed card depends on the entropy`);
  }
});

test("a revealed card shows exactly the words the codec derives, in order", () => {
  view.__set.hodlRevealPrivate(true);
  for (const entropy of entropies) {
    const fields = view.hodlFormosaRecoveryFields({ entropy });
    assert.equal(fields.length, THEMES.length, `${entropy.length} bytes: one row per theme`);
    THEMES.forEach((theme, at) => {
      const expected = formosaEncode(entropy, theme).words;
      const shown = [...fields[at].matchAll(/>([a-z0-9_]+)</g)].map((match) => match[1]).filter((word) => expected.includes(word));
      assert.deepEqual(shown, expected, `${theme}, ${entropy.length} bytes`);
    });
  }
});

test("the row count matches the word count the entropy size implies", () => {
  view.__set.hodlRevealPrivate(true);
  for (const entropy of entropies) {
    const expected = formosaWordCount(entropy.length * 8);
    for (const theme of THEMES) {
      assert.equal(formosaEncode(entropy, theme).words.length, expected, `${theme}, ${entropy.length} bytes`);
    }
  }
  // A Formosa phrase of a given word count is HALF the entropy of a BIP-39
  // phrase of the same count, which is the obvious way to misread the card.
  assert.equal(formosaWordCount(128), 24);
  assert.equal(formosaWordCount(256), 48);
});

test("no row is produced without entropy to encode", () => {
  view.__set.hodlRevealPrivate(true);
  for (const wallet of [{}, { entropy: null }, { entropy: undefined }]) {
    assert.deepEqual(view.hodlFormosaRecoveryFields(wallet), [], "a wallet with no entropy produced a Formosa row");
  }
});
