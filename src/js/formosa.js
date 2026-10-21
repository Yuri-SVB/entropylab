// Formosa (BIP-450) encoding and decoding for EntropyLab.
//
// Formosa re-encodes BIP-39 entropy as sentences. It derives nothing new: the
// same entropy yields the same BIP-39 phrase and the same seed, so this module
// is a second alphabet for a key, never a second key.
//
// Entropy plus its BIP-39 checksum is cut into 33-bit segments, one sentence
// each. Within a segment the bits are consumed in the theme's FILLING order,
// each position taking BIT_LENGTH of them; the words are shown and typed in
// its NATURAL order, which for medieval_fantasy is a different order. An
// unrestricted position indexes its own word list. A restricted one indexes
// the row of its leader's matrix, so which words are even available depends on
// the word already chosen for the leading position — that is what makes the
// sentences read as sentences.
//
// Pure data in, pure data out: no DOM, no randomness, no network. Errors are
// returned as structured codes rather than thrown, because every one of them
// is something a person can type and must be told about in their own language.

import { sha256 } from "./hashes.js";
import { formosaThemes } from "./formosa-themes.js";

// The BIP-39 sizes, which are the only ones Formosa divides evenly: entropy
// plus checksum is a whole number of 33-bit sentences at each.
const SIZES = Object.freeze([16, 20, 24, 28, 32]);
const PHRASE_BITS = 33;

function theme(themeId) {
  const data = formosaThemes[themeId];
  if (!data) throw new Error(`unknown Formosa theme: ${themeId}`);
  return data;
}

// A position either owns a word list or names the position that owns it.
// global's second origin and profession share the first's, and
// medieval_fantasy's wildcard is its subject list again.
function wordsOf(data, position) {
  const list = data.words[position];
  return typeof list === "string" ? data.words[list] : list;
}

// How many words a phrase of this entropy size holds. Six per sentence, and
// one sentence per 33 bits of entropy-plus-checksum.
export function formosaWordCount(bits) {
  const total = bits + bits / 32;
  return (total / PHRASE_BITS) * 6;
}

function bitsOf(entropy) {
  let out = "";
  for (const byte of entropy) out += byte.toString(2).padStart(8, "0");
  const digest = sha256(entropy);
  let checksum = "";
  for (const byte of digest) checksum += byte.toString(2).padStart(8, "0");
  return out + checksum.slice(0, (entropy.length * 8) / 32);
}

export function formosaEncode(entropy, themeId) {
  const data = theme(themeId);
  if (!(entropy instanceof Uint8Array) || !SIZES.includes(entropy.length)) {
    throw new Error(`Formosa needs an entropy length BIP-39 defines (${SIZES.join(", ")} bytes), not ${entropy?.length}`);
  }
  const bits = bitsOf(entropy);
  const words = [];
  const phrases = [];
  for (let at = 0; at < bits.length; at += PHRASE_BITS) {
    const segment = bits.slice(at, at + PHRASE_BITS);
    const chosen = {};
    let cursor = 0;
    data.filling.forEach((position, index) => {
      const slice = Number.parseInt(segment.slice(cursor, cursor + data.bits[index]), 2);
      cursor += data.bits[index];
      const lead = data.ledBy[index];
      // An unrestricted slice indexes the word list; a restricted one indexes
      // the leader's row, which then names the word.
      const wordIndex = lead === null ? slice : data.mapping[`${lead}>${position}`][chosen[lead]][slice];
      chosen[position] = wordIndex;
    });
    const sentence = data.natural.map((position) => wordsOf(data, position)[chosen[position]]);
    phrases.push(sentence);
    words.push(...sentence);
  }
  return { words, phrases };
}

// What may be typed at one position of a phrase in progress.
//
// A restricted position is constrained only once its leader can be read. Two
// of medieval_fantasy's positions are led by a word that comes later in the
// sentence than they do, so left to right their leader is not yet there; the
// whole list is offered and the answer says it is unconstrained, rather than
// pretending to a constraint it cannot know. Once the leader arrives the set
// narrows, and a word that no longer fits is reported by formosaAnalyze.
export function formosaCandidates(words, at, themeId) {
  const data = theme(themeId);
  const perPhrase = data.natural.length;
  const position = data.natural[at % perPhrase];
  const index = data.filling.indexOf(position);
  const lead = data.ledBy[index];
  const list = wordsOf(data, position);
  if (lead === null) return { position, lead: null, leadWord: "", words: list, constrained: false };
  // The leader is the one in this sentence, not the first in the phrase.
  const sentence = Math.floor(at / perPhrase) * perPhrase;
  const leadWord = String(words?.[sentence + data.natural.indexOf(lead)] ?? "");
  const leadIndex = wordsOf(data, lead).indexOf(leadWord);
  if (leadIndex < 0) return { position, lead, leadWord, words: list, constrained: false };
  return { position, lead, leadWord, words: data.mapping[`${lead}>${position}`][leadIndex].map((pick) => list[pick]), constrained: true };
}

// A phrase as it is being typed: what is wrong with it, and whether it is yet
// a phrase at all. It guesses nothing — the checksum verdict is the decoder's.
export function formosaAnalyze(words, themeId) {
  const data = theme(themeId);
  const perPhrase = data.natural.length;
  const list = Array.isArray(words) ? words.map((word) => String(word ?? "")) : [];
  const invalid = [];
  const forbidden = [];

  list.forEach((word, at) => {
    const position = data.natural[at % perPhrase];
    if (wordsOf(data, position).indexOf(word) < 0) {
      invalid.push({ at, word, position });
      return;
    }
    const candidates = formosaCandidates(list, at, themeId);
    if (candidates.constrained && !candidates.words.includes(word)) {
      forbidden.push({ at, word, position, lead: candidates.lead, leadWord: candidates.leadWord });
    }
  });

  // Only a length that is entropy plus its own checksum is a phrase, and only
  // a phrase with every word in place is worth handing to the decoder.
  const whole = list.length > 0 && list.length % perPhrase === 0;
  const entropyBytes = whole ? ((list.length / perPhrase) * PHRASE_BITS * 32) / 33 / 8 : 0;
  const complete = whole && SIZES.includes(entropyBytes) && !invalid.length && !forbidden.length;

  let checksumOk = false;
  let entropy = null;
  let bits = 0;
  let error = null;
  if (complete) {
    const decoded = formosaDecode(list, themeId);
    checksumOk = decoded.ok;
    if (decoded.ok) ({ entropy, bits } = decoded);
    else error = decoded.error;
  }
  return { count: list.length, perPhrase, complete, checksumOk, entropy, bits, invalid, forbidden, error };
}

// The 33 bits one sentence carries, or what is wrong with it. Shared by the
// decoder and by the partial read a half-typed phrase needs, so the two can
// never disagree about what a sentence means.
function sentenceBits(data, sentence) {
  const chosen = {};
  // Resolve every position first: a led position needs its leader's word, and
  // the leader is not always earlier in the sentence as it is read.
  for (const position of data.filling) {
    const word = sentence[data.natural.indexOf(position)];
    const index = wordsOf(data, position).indexOf(word);
    if (index < 0) return { ok: false, unknown: true, word, position };
    chosen[position] = index;
  }
  let bits = "";
  for (const [index, position] of data.filling.entries()) {
    const lead = data.ledBy[index];
    // The bit value is where the word sits in the leader's row, not where it
    // sits in the whole list. A word absent from that row is a word the leader
    // does not allow, and refusing it is the point.
    const slice = lead === null ? chosen[position] : data.mapping[`${lead}>${position}`][chosen[lead]].indexOf(chosen[position]);
    if (slice < 0) {
      return { ok: false, unknown: false, word: sentence[data.natural.indexOf(position)], position, lead, leadWord: sentence[data.natural.indexOf(lead)] };
    }
    bits += slice.toString(2).padStart(data.bits[index], "0");
  }
  return { ok: true, bits };
}

// The bits of the sentences that are finished and sound, for a phrase still
// being typed. It stops at the first sentence that is not — a reader of a
// partial phrase is entitled to what is settled and nothing beyond it.
export function formosaPartialBits(words, themeId) {
  const data = theme(themeId);
  const list = Array.isArray(words) ? words.map((word) => String(word ?? "")) : [];
  const perPhrase = data.natural.length;
  let out = "";
  for (let phrase = 0; phrase + perPhrase <= list.length; phrase += perPhrase) {
    const segment = sentenceBits(data, list.slice(phrase, phrase + perPhrase));
    if (!segment.ok) break;
    out += segment.bits;
  }
  return out;
}

export function formosaDecode(words, themeId) {
  const data = theme(themeId);
  const list = Array.isArray(words) ? words.map((word) => String(word ?? "")) : [];
  const perPhrase = data.natural.length;

  if (!list.length || list.length % perPhrase !== 0) {
    return { ok: false, error: { key: "A {theme} phrase is a whole number of {n}-word sentences; {have} entered.", vars: { theme: themeId, n: perPhrase, have: list.length } } };
  }
  const phrases = list.length / perPhrase;
  const bits = phrases * PHRASE_BITS;
  // Only a length that is entropy plus its own checksum can be meant.
  const entropyBits = (bits * 32) / 33;
  if (!SIZES.includes(entropyBits / 8)) {
    return { ok: false, error: { key: "{have} words is not a Formosa phrase length; {sizes} words are.", vars: { have: list.length, sizes: SIZES.map((size) => formosaWordCount(size * 8)).join(", ") } } };
  }

  let out = "";
  for (let phrase = 0; phrase < phrases; phrase++) {
    const segment = sentenceBits(data, list.slice(phrase * perPhrase, (phrase + 1) * perPhrase));
    if (!segment.ok) {
      return { ok: false, error: segment.unknown
        ? { key: "\"{word}\" is not a {position} word in the {theme} theme.", vars: { word: segment.word, position: segment.position, theme: themeId } }
        : { key: "\"{word}\" cannot follow \"{lead}\" in the {theme} theme.", vars: { word: segment.word, lead: segment.leadWord, theme: themeId } } };
    }
    out += segment.bits;
  }

  const entropy = new Uint8Array(entropyBits / 8);
  for (let at = 0; at < entropy.length; at++) entropy[at] = Number.parseInt(out.slice(at * 8, at * 8 + 8), 2);
  if (bitsOf(entropy) !== out) {
    return { ok: false, error: { key: "The phrase is well formed but its checksum does not match, so a word is wrong.", vars: {} } };
  }
  return { ok: true, entropy, bits: entropyBits };
}
