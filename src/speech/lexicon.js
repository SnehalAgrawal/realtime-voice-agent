// The pronunciation dictionary for the local Kokoro voice, and what it is missing.
//
// sherpa-onnx (since 2.0) pronounces English from a word list instead of espeak-ng, and
// skips any word that is not in it, with only a log line. The list has 178,401 entries
// but no rule for regular endings: "open" and "opening" are there, "opens" and "opened"
// are not. Kokoro's own frontend (misaki) derives those from the stem; this does the same,
// with misaki's US suffix rules, and writes the derived words to a second dictionary file
// that is loaded next to the original.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spellOut } from "./normalize.js";

const STRESS = new Set(["ˈ", "ˌ"]);
const VOICELESS_S = new Set(["p", "t", "k", "f", "θ"]);
const SIBILANTS = new Set(["s", "z", "ʃ", "ʒ", "ʧ", "ʤ"]);
const VOICELESS_ED = new Set(["p", "k", "f", "θ", "ʃ", "s", "ʧ"]);

/** Letter names that are not in the dictionary, with misaki-style phonemes. */
const EXTRA_WORDS = {
  ay: "ˈ A",
  ee: "ˈ i",
  ef: "ˈ ɛ f",
  ar: "ˈ ɑ ɹ",
};

/** Reads "word p h o n e m e s" lines into a Map. */
export function readLexicon(path) {
  const entries = new Map();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0) entries.set(line.slice(0, space), line.slice(space + 1));
  }
  return entries;
}

function lastPhoneme(phonemes) {
  const tokens = phonemes.split(" ");
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (!STRESS.has(tokens[i]) && tokens[i] !== "ː") return tokens[i];
  }
  return "";
}

/** Spelling and pronunciation of -s, -ed, and -ing forms (misaki's US rules). */
export function inflections(word, phonemes) {
  const last = lastPhoneme(phonemes);
  const consonantY = /[^aeiou]y$/.test(word);

  const sSpelling = /(s|x|z|ch|sh)$/.test(word) ? `${word}es` : consonantY ? `${word.slice(0, -1)}ies` : `${word}s`;
  const sSound = VOICELESS_S.has(last) ? "s" : SIBILANTS.has(last) ? "ᵻ z" : "z";

  const edSpelling = word.endsWith("e") ? `${word}d` : consonantY ? `${word.slice(0, -1)}ied` : `${word}ed`;
  const edSound = VOICELESS_ED.has(last) ? "t" : last === "t" || last === "d" ? "ᵻ d" : "d";

  let ingSpelling;
  if (word.endsWith("ie")) ingSpelling = `${word.slice(0, -2)}ying`;
  else if (/[^aeiouy]e$/.test(word) && word.length > 2) ingSpelling = `${word.slice(0, -1)}ing`;
  else ingSpelling = `${word}ing`;

  return [
    [sSpelling, `${phonemes} ${sSound}`],
    [edSpelling, `${phonemes} ${edSound}`],
    [ingSpelling, `${phonemes} ɪ ŋ`],
  ];
}

/** Every derived word that the dictionary does not already have. */
export function deriveEntries(entries) {
  const derived = new Map();
  for (const [word, phonemes] of entries) {
    if (!/^[a-z]{2,}$/.test(word)) continue;
    for (const [form, sound] of inflections(word, phonemes)) {
      if (!entries.has(form) && !derived.has(form)) derived.set(form, sound);
    }
  }
  for (const [word, phonemes] of Object.entries(EXTRA_WORDS)) {
    if (!entries.has(word)) derived.set(word, phonemes);
  }
  return derived;
}

/**
 * Loads a dictionary and its derived companion (writing the companion next to it the
 * first time). Returns the files to give sherpa-onnx and a lookup for every known word.
 */
export function loadLexicon(path) {
  const derivedPath = path.replace(/\.txt$/, "-derived.txt");
  const entries = readLexicon(path);
  let derived;
  if (existsSync(derivedPath) && statSync(derivedPath).mtimeMs >= statSync(path).mtimeMs) {
    derived = readLexicon(derivedPath);
  } else {
    derived = deriveEntries(entries);
    const lines = [...derived].map(([word, phonemes]) => `${word} ${phonemes}`);
    writeFileSync(derivedPath, `${lines.join("\n")}\n`);
  }
  const has = (word) => entries.has(word) || derived.has(word);
  return { files: [path, derivedPath], has, size: entries.size, derivedSize: derived.size };
}

/**
 * Prepares text for the dictionary: spells out unknown acronyms ("API" → "ay pee eye"),
 * reads an unknown possessive as its plural ("Smith's" sounds like "Smiths"), and lists
 * the words that will still be skipped.
 *
 * @param {string} text  already normalised (numbers in words)
 * @param {(word: string) => boolean} has
 */
export function prepareWords(text, has) {
  const outOfVocabulary = [];
  const prepared = text.replace(/[A-Za-z][A-Za-z'’]*/g, (word) => {
    const plain = word.replace(/’/g, "'");
    const lower = plain.toLowerCase();
    if (has(lower)) return word;
    if (/^[A-Z]{2,6}s?$/.test(plain)) {
      const plural = plain.endsWith("s") && plain.length > 2;
      return plural ? `${spellOut(plain.slice(0, -1))}s` : spellOut(plain);
    }
    if (lower.endsWith("'s") && has(`${lower.slice(0, -2)}s`)) return `${plain.slice(0, -2)}s`;
    if (lower.endsWith("'s") && /^[A-Z]{2,6}'s$/.test(plain)) return `${spellOut(plain.slice(0, -2))}s`;
    outOfVocabulary.push(word);
    return word;
  });
  return { text: prepared, outOfVocabulary };
}
