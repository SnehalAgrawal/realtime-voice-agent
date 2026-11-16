// Splits streamed LLM text into pieces that can be synthesised one at a time.
//
// Modes:
//   "sentence"  split after . ! ? (and at line breaks)
//   "clause"    also split after , ; : once the piece is at least `minClauseChars` long
//   "whole"     never split; the reply is synthesised in one piece when the stream ends
//
// A boundary is only confirmed when the character after the punctuation arrives and is
// whitespace, so "3.5", "example.com", and "e.g." inside a token stream are not split.

const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "st", "sr", "jr", "vs", "etc", "e.g", "i.e", "a.m", "p.m",
]);

const SENTENCE_END = /[.!?]/;
const CLAUSE_END = /[,;:]/;
const CLOSERS = /["')\]’”*_]/;

export class SentenceChunker {
  #buffer = "";
  #mode;
  #minClauseChars;

  constructor({ mode = "sentence", minClauseChars = 24 } = {}) {
    if (!["sentence", "clause", "whole"].includes(mode)) {
      throw new Error(`Unknown chunking mode: ${mode}`);
    }
    this.#mode = mode;
    this.#minClauseChars = minClauseChars;
  }

  /** Adds streamed text and returns the pieces it completed (possibly none). */
  push(text) {
    this.#buffer += text;
    if (this.#mode === "whole") return [];
    const pieces = [];
    let start = 0;
    for (let i = 0; i < this.#buffer.length; i++) {
      const ch = this.#buffer[i];
      if (ch === "\n") {
        pieces.push(this.#buffer.slice(start, i));
        start = i + 1;
        continue;
      }
      const isSentence = SENTENCE_END.test(ch);
      const isClause = this.#mode === "clause" && CLAUSE_END.test(ch);
      if (!isSentence && !isClause) continue;
      // Include closing quotes or brackets that follow the punctuation.
      let end = i + 1;
      while (end < this.#buffer.length && CLOSERS.test(this.#buffer[end])) end++;
      // Wait for the next character before deciding.
      if (end >= this.#buffer.length) break;
      if (!/\s/.test(this.#buffer[end])) continue;
      const piece = this.#buffer.slice(start, end);
      if (isSentence && ch === "." && endsWithAbbreviation(piece)) continue;
      if (!isSentence && piece.trim().length < this.#minClauseChars) continue;
      pieces.push(piece);
      start = end;
      i = end - 1;
    }
    this.#buffer = this.#buffer.slice(start);
    return pieces.map((p) => p.trim()).filter(Boolean);
  }

  /** Returns whatever is left when the stream ends. */
  flush() {
    const rest = this.#buffer.trim();
    this.#buffer = "";
    return rest ? [rest] : [];
  }
}

function endsWithAbbreviation(piece) {
  const word = piece.trim().split(/\s+/).pop().toLowerCase().replace(/\.$/, "");
  return ABBREVIATIONS.has(word);
}

/**
 * Turns model text into text a speech engine should read: drops Markdown markers,
 * list bullets, and emoji that would be read aloud or mispronounced.
 */
export function toSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|~~)(\S(?:[\s\S]*?\S)?)\1/g, "$2")
    .replace(/^\s*(?:[-*•]|\d+[.)]|#{1,6})\s+/gm, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
