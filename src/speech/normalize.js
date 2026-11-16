// Rewrites text into words a dictionary-based speech synthesiser can pronounce.
//
// The local Kokoro voice looks every word up in a pronunciation dictionary and silently
// skips words it cannot find: digits, "$25", "20%", and "9:30" were all dropped in testing.
// This turns them into words first. Hosted speech services do their own normalisation,
// so only the local provider uses it.

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = [
  [1e12, "trillion"],
  [1e9, "billion"],
  [1e6, "million"],
  [1e3, "thousand"],
];

/** 0 to 999,999,999,999,999 in words, e.g. 2026 → "two thousand twenty six". */
export function numberToWords(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Unsupported number: ${n}`);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : "");
  if (n < 1000) {
    return `${ONES[Math.floor(n / 100)]} hundred` + (n % 100 ? ` ${numberToWords(n % 100)}` : "");
  }
  for (const [value, name] of SCALES) {
    if (n >= value) {
      const rest = n % value;
      return `${numberToWords(Math.floor(n / value))} ${name}` + (rest ? ` ${numberToWords(rest)}` : "");
    }
  }
  throw new Error("unreachable");
}

const ORDINAL_WORDS = {
  one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth",
};

/** 21 → "twenty first". */
export function ordinalToWords(n) {
  const words = numberToWords(n).split(" ");
  const last = words.pop();
  let ordinal;
  if (ORDINAL_WORDS[last]) ordinal = ORDINAL_WORDS[last];
  else if (last.endsWith("y")) ordinal = `${last.slice(0, -1)}ieth`;
  else ordinal = `${last}th`;
  return [...words, ordinal].join(" ");
}

const digits = (s) => [...s].map((d) => ONES[Number(d)]).join(" ");
const integer = (s) => numberToWords(Number(s.replace(/,/g, "")));

export function normalizeForSpeech(text) {
  return (
    text
      // $25.50 → 25 dollars and 50 cents
      .replace(/\$(\d[\d,]*)(?:\.(\d{2}))?\b/g, (_, whole, cents) => {
        const dollars = `${integer(whole)} ${whole === "1" ? "dollar" : "dollars"}`;
        if (!cents || cents === "00") return dollars;
        return `${dollars} and ${integer(cents)} ${cents === "01" ? "cent" : "cents"}`;
      })
      // 20% → 20 percent
      .replace(/(\d+(?:\.\d+)?)\s?%/g, "$1 percent")
      // 9:30 → nine thirty; 9:05 → nine oh five; 9:00 → nine o'clock (or "nine" before a.m./p.m.)
      .replace(/\b(\d{1,2}):(\d{2})\b(\s*[ap]\.?m\.?)?/gi, (_, h, m, suffix) => {
        const hour = integer(h);
        let minutes;
        if (m === "00") minutes = suffix ? "" : " o'clock";
        else if (m.startsWith("0")) minutes = ` oh ${ONES[Number(m[1])]}`;
        else minutes = ` ${integer(m)}`;
        return `${hour}${minutes}${suffix ? ` ${suffix.trim()}` : ""}`;
      })
      // 21st → twenty first
      .replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_, n) => ordinalToWords(Number(n)))
      // 3.14 → three point one four
      .replace(/\b(\d+)\.(\d+)\b/g, (_, whole, fraction) => `${integer(whole)} point ${digits(fraction)}`)
      // COVID-19 → COVID 19
      .replace(/([A-Za-z])-(\d)/g, "$1 $2")
      // 1,250 → one thousand two hundred fifty; very long digit runs (phone numbers) are read digit by digit
      .replace(/\b\d{1,3}(?:,\d{3})+\b|\b\d+\b/g, (n) => (n.replace(/,/g, "").length > 12 ? digits(n) : integer(n)))
      .replace(/\s+/g, " ")
      .trim()
  );
}

const LETTER_NAMES = {
  a: "ay", b: "bee", c: "see", d: "dee", e: "ee", f: "ef", g: "gee", h: "aitch", i: "eye", j: "jay",
  k: "kay", l: "el", m: "em", n: "en", o: "oh", p: "pee", q: "cue", r: "ar", s: "ess", t: "tee",
  u: "you", v: "vee", w: "double you", x: "ex", y: "why", z: "zee",
};

/** "API" → "ay pee eye". */
export function spellOut(word) {
  return [...word.toLowerCase()].map((ch) => LETTER_NAMES[ch] ?? "").filter(Boolean).join(" ");
}
