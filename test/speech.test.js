import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveEntries, inflections, prepareWords } from "../src/speech/lexicon.js";
import { normalizeForSpeech, numberToWords, ordinalToWords, spellOut } from "../src/speech/normalize.js";
import {
  decodeMuLaw, decodeWav, encodeMuLaw, encodeWav, float32ToInt16, int16ToFloat32, resample,
} from "../src/speech/pcm.js";

test("numberToWords and ordinalToWords", () => {
  assert.equal(numberToWords(0), "zero");
  assert.equal(numberToWords(15), "fifteen");
  assert.equal(numberToWords(42), "forty two");
  assert.equal(numberToWords(100), "one hundred");
  assert.equal(numberToWords(2026), "two thousand twenty six");
  assert.equal(numberToWords(1_250_000), "one million two hundred fifty thousand");
  assert.equal(ordinalToWords(1), "first");
  assert.equal(ordinalToWords(12), "twelfth");
  assert.equal(ordinalToWords(21), "twenty first");
  assert.equal(ordinalToWords(30), "thirtieth");
  assert.throws(() => numberToWords(-1));
});

test("normalizeForSpeech turns numbers, money, percentages, and times into words", () => {
  const cases = {
    "Our clinic opens at 9:30 a.m.": "Our clinic opens at nine thirty a.m.",
    "Come at 9:05.": "Come at nine oh five.",
    "We close at 6:00.": "We close at six o'clock.",
    "Open 9:00 AM daily.": "Open nine AM daily.",
    "It costs $25.50.": "It costs twenty five dollars and fifty cents.",
    "Only $1 today.": "Only one dollar today.",
    "About 20% less.": "About twenty percent less.",
    "Pi is 3.14.": "Pi is three point one four.",
    "On the 21st.": "On the twenty first.",
    "COVID-19 tests": "COVID nineteen tests",
    "1,250 people": "one thousand two hundred fifty people",
    "No numbers here.": "No numbers here.",
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(normalizeForSpeech(input), expected, input);
});

test("spellOut uses letter names", () => {
  assert.equal(spellOut("API"), "ay pee eye");
  assert.equal(spellOut("URL"), "you ar el");
});

test("inflections follow the US suffix rules", () => {
  const forms = (word, phonemes) => Object.fromEntries(inflections(word, phonemes));
  assert.deepEqual(forms("open", "ˈ O p ᵊ n"), {
    opens: "ˈ O p ᵊ n z",
    opened: "ˈ O p ᵊ n d",
    opening: "ˈ O p ᵊ n ɪ ŋ",
  });
  assert.deepEqual(forms("want", "w ˈ ɑ n t"), {
    wants: "w ˈ ɑ n t s",
    wanted: "w ˈ ɑ n t ᵻ d",
    wanting: "w ˈ ɑ n t ɪ ŋ",
  });
  assert.deepEqual(Object.keys(forms("close", "k l ˈ O z")), ["closes", "closed", "closing"]);
  assert.equal(forms("close", "k l ˈ O z").closes, "k l ˈ O z ᵻ z");
  assert.deepEqual(Object.keys(forms("carry", "k ˈ æ ɹ i")), ["carries", "carried", "carrying"]);
  assert.deepEqual(Object.keys(forms("watch", "w ˈ ɑ ʧ")), ["watches", "watched", "watching"]);
  assert.equal(forms("watch", "w ˈ ɑ ʧ").watched, "w ˈ ɑ ʧ t");
});

test("deriveEntries adds only missing forms, plus missing letter names", () => {
  const entries = new Map([
    ["open", "ˈ O p ᵊ n"],
    ["opening", "ˈ O p ᵊ n ɪ ŋ"],
    ["bee", "b ˈ i"],
  ]);
  const derived = deriveEntries(entries);
  assert.ok(derived.has("opens") && derived.has("opened"));
  assert.ok(!derived.has("opening"), "already in the dictionary");
  assert.ok(derived.has("ay") && derived.has("ef"));
});

test("prepareWords spells out unknown acronyms, reads possessives as plurals, and lists the rest", () => {
  const known = new Set(["the", "is", "down", "from", "smiths", "team", "at", "ay", "pee", "eye", "you", "ar", "els"]);
  const has = (w) => known.has(w);
  assert.deepEqual(prepareWords("The API is down", has), { text: "The ay pee eye is down", outOfVocabulary: [] });
  assert.deepEqual(prepareWords("from Smith's team", has), { text: "from Smiths team", outOfVocabulary: [] });
  assert.deepEqual(prepareWords("URLs at Ollama", has), { text: "you ar els at Ollama", outOfVocabulary: ["Ollama"] });
});

test("PCM conversions round-trip", () => {
  const samples = Int16Array.from([0, 1000, -1000, 32767, -32768]);
  assert.deepEqual(float32ToInt16(int16ToFloat32(samples)), samples);
  const wav = decodeWav(encodeWav({ samples, sampleRate: 16000 }));
  assert.equal(wav.sampleRate, 16000);
  assert.deepEqual(wav.samples, samples);
});

test("mu-law keeps speech-level samples within the codec's step size", () => {
  const samples = Int16Array.from({ length: 200 }, (_, i) => Math.round(Math.sin(i / 5) * 12000));
  const decoded = decodeMuLaw(encodeMuLaw(samples));
  for (let i = 0; i < samples.length; i++) {
    assert.ok(Math.abs(decoded[i] - samples[i]) <= Math.max(16, Math.abs(samples[i]) * 0.07), `sample ${i}`);
  }
  assert.deepEqual([...encodeMuLaw(Int16Array.from([0]))], [0xff]);
});

test("resample changes length by the rate ratio and keeps a tone's level", () => {
  const tone = Int16Array.from({ length: 2400 }, (_, i) => Math.round(Math.sin((2 * Math.PI * 300 * i) / 24000) * 10000));
  const down = resample(tone, 24000, 16000);
  assert.equal(down.length, 1600);
  const peak = Math.max(...down.map(Math.abs));
  assert.ok(peak > 9000 && peak <= 10000, `peak ${peak}`);
  assert.equal(resample(tone, 16000, 16000), tone);
  assert.equal(resample(Int16Array.from([0, 100]), 8000, 16000).length, 4);
});
