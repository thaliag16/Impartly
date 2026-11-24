// Word error rate for speech-to-text tests: (substitutions + deletions + insertions) /
// words in the reference, after both texts are normalized the same way, so that case,
// punctuation and "twelve hundred" vs "1,200" do not count as errors.

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};
const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9 };

type Kind = "unit" | "teen" | "ten" | "hundred" | "scale" | "digits";

const isSmallNumberWord = (word: string | undefined) =>
  word !== undefined && (word in UNITS || word in TEENS || word in TENS);

/**
 * Rewrites runs of number words (and digits followed by a scale word) as one digit
 * string: "twelve hundred" and "one thousand two hundred" both become "1200", "forty
 * million" and "40 million" both become "40000000", "three point five" becomes "3.5".
 * Separate numbers stay separate ("two three" is "2", "3").
 */
export function wordsToNumbers(words: string[]): string[] {
  const out: string[] = [];
  let total = 0; // sum of completed scale groups
  let group = 0; // current group below the next scale word
  let last: Kind | null = null;
  let lastScale = Infinity;
  let decimals = ""; // digits after "point"

  const flush = () => {
    if (last === null) return;
    const value = total + group;
    out.push(decimals ? `${value}.${decimals}` : String(value));
    total = 0;
    group = 0;
    last = null;
    lastScale = Infinity;
    decimals = "";
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const next = words[i + 1];

    if (/^\d+(\.\d+)?$/.test(word)) {
      flush();
      if (word.includes(".")) {
        // A decimal only combines with a following scale word ("1.5 billion").
        const scale = SCALES[next ?? ""];
        if (scale) {
          out.push(String(Math.round(Number(word) * scale)));
          i++;
        } else {
          out.push(word);
        }
        continue;
      }
      group = Number(word);
      last = "digits";
      continue;
    }

    if (word in UNITS || word in TEENS || word in TENS) {
      const value = UNITS[word] ?? TEENS[word] ?? TENS[word];
      const kind: Kind = word in UNITS ? "unit" : word in TEENS ? "teen" : "ten";
      const continues =
        !decimals &&
        ((last === "ten" && kind === "unit" && group % 10 === 0 && value > 0) ||
          ((last === "hundred" || last === "scale") && value > 0));
      if (!continues) flush();
      group += value;
      last = kind;
      continue;
    }

    if (word === "point" && (last === "unit" || last === "teen" || last === "ten" || last === "digits") && next !== undefined && next in UNITS) {
      while (words[i + 1] !== undefined && words[i + 1] in UNITS) decimals += String(UNITS[words[++i]]);
      continue;
    }

    if (word === "hundred" && (last === "unit" || last === "teen" || last === "ten" || last === "digits") && group > 0 && group < 100) {
      group *= 100;
      last = "hundred";
      continue;
    }

    if (word in SCALES && last !== null && last !== "scale" && SCALES[word] < lastScale && (group > 0 || decimals)) {
      const scale = SCALES[word];
      total += Math.round((group + (decimals ? Number(`0.${decimals}`) : 0)) * scale);
      group = 0;
      decimals = "";
      lastScale = scale;
      last = "scale";
      continue;
    }

    // "one hundred and five", "two thousand and twenty".
    if (word === "and" && (last === "hundred" || last === "scale") && isSmallNumberWord(next)) continue;

    flush();
    out.push(word);
  }
  flush();
  return out;
}

/** Lowercased words without punctuation, with numbers written as digits. */
export function normalizeTranscript(text: string): string[] {
  const prepared = text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    // "$40 million" -> "40 million dollars"
    .replace(/\$\s?(\d[\d,]*(?:\.\d+)?)(\s+(?:hundred|thousand|million|billion))?/g, "$1$2 dollars")
    .replace(/%/g, " percent")
    // "1,200" -> "1200"
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/[-‐-―/]/g, " ");
  const words = prepared
    .split(/\s+/)
    .map((token) => {
      const cleaned = token.replace(/[^a-z0-9.]/g, "");
      // Keep a dot only as a decimal point between digits.
      return cleaned.replace(/\.(?!\d)|(?<!\d)\./g, "");
    })
    .filter(Boolean);
  return wordsToNumbers(words);
}

function editDistance(reference: string[], hypothesis: string[]): number {
  let previous = Array.from({ length: hypothesis.length + 1 }, (_, j) => j);
  for (let i = 1; i <= reference.length; i++) {
    const current = [i];
    for (let j = 1; j <= hypothesis.length; j++) {
      const substitution = previous[j - 1] + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1);
      current.push(Math.min(substitution, previous[j] + 1, current[j - 1] + 1));
    }
    previous = current;
  }
  return previous[hypothesis.length];
}

/** Word error rate of a transcript against the reference text (0 is perfect; can exceed 1). */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const expected = normalizeTranscript(reference);
  if (expected.length === 0) throw new Error("reference text has no words");
  return editDistance(expected, normalizeTranscript(hypothesis)) / expected.length;
}
