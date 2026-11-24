import { describe, expect, it } from "vitest";
import { normalizeTranscript, wordErrorRate, wordsToNumbers } from "./wer";

describe("normalizeTranscript", () => {
  it("lowercases and drops punctuation, keeping words joined by apostrophes", () => {
    expect(normalizeTranscript("Wait, go back. What's that?!")).toEqual(["wait", "go", "back", "whats", "that"]);
    expect(normalizeTranscript("  “Quoted” — text… ")).toEqual(["quoted", "text"]);
  });

  it("splits hyphenated words", () => {
    expect(normalizeTranscript("follow-up")).toEqual(["follow", "up"]);
  });

  it("writes numbers the same whether spoken as words or digits", () => {
    expect(normalizeTranscript("forty million dollars")).toEqual(["40000000", "dollars"]);
    expect(normalizeTranscript("40 million dollars")).toEqual(["40000000", "dollars"]);
    expect(normalizeTranscript("$40 million")).toEqual(["40000000", "dollars"]);
    expect(normalizeTranscript("twelve thousand")).toEqual(normalizeTranscript("12,000"));
    expect(normalizeTranscript("one thousand two hundred jobs")).toEqual(["1200", "jobs"]);
    expect(normalizeTranscript("twelve hundred jobs")).toEqual(["1200", "jobs"]);
    expect(normalizeTranscript("1,200 jobs")).toEqual(["1200", "jobs"]);
    expect(normalizeTranscript("twenty-five")).toEqual(["25"]);
    expect(normalizeTranscript("one hundred and five")).toEqual(["105"]);
    expect(normalizeTranscript("three point five")).toEqual(["3.5"]);
    expect(normalizeTranscript("3.5.")).toEqual(["3.5"]);
  });

  it("spells out percent and dollar signs", () => {
    expect(normalizeTranscript("fell 12%")).toEqual(["fell", "12", "percent"]);
    expect(normalizeTranscript("fell twelve percent")).toEqual(["fell", "12", "percent"]);
    expect(normalizeTranscript("$40")).toEqual(["40", "dollars"]);
    expect(normalizeTranscript("$1.5 billion")).toEqual(["1500000000", "dollars"]);
  });

  it("does not turn ordinary words into numbers", () => {
    expect(normalizeTranscript("and then one of them")).toEqual(["and", "then", "1", "of", "them"]);
    expect(normalizeTranscript("rock and roll")).toEqual(["rock", "and", "roll"]);
    // "and" only joins numbers after "hundred" etc.; two separate numbers stay separate.
    expect(normalizeTranscript("two and three")).toEqual(["2", "and", "3"]);
  });
});

describe("wordsToNumbers", () => {
  it("keeps separate numbers separate", () => {
    expect(wordsToNumbers(["two", "three"])).toEqual(["2", "3"]);
    expect(wordsToNumbers(["nineteen", "ninety"])).toEqual(["19", "90"]);
    expect(wordsToNumbers(["two", "million", "five", "hundred", "thousand"])).toEqual(["2500000"]);
  });
});

describe("wordErrorRate", () => {
  it("is zero for the same words, ignoring case, punctuation and number form", () => {
    expect(wordErrorRate("Did they cut 1,200 jobs?", "did they cut twelve hundred jobs")).toBe(0);
  });

  it("counts substitutions, deletions and insertions over the reference length", () => {
    const reference = "who led the funding round";
    expect(wordErrorRate(reference, "who led the funding round")).toBe(0);
    expect(wordErrorRate(reference, "who read the funding round")).toBeCloseTo(1 / 5); // substitution
    expect(wordErrorRate(reference, "who led funding round")).toBeCloseTo(1 / 5); // deletion
    expect(wordErrorRate(reference, "so who led the funding round")).toBeCloseTo(1 / 5); // insertion
    expect(wordErrorRate(reference, "")).toBe(1);
    expect(wordErrorRate(reference, "a b c d e f g h i j")).toBeCloseTo(10 / 5); // can exceed 1
  });

  it("counts a company name split in two as two errors", () => {
    expect(wordErrorRate("Pinecrest Energy", "Pine crest Energy")).toBeCloseTo(2 / 2);
  });

  it("rejects an empty reference", () => {
    expect(() => wordErrorRate("", "anything")).toThrow();
  });
});
