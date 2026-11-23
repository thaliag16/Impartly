import { describe, expect, it } from "vitest";
import { splitSentences } from "./sentences";

const words = (text: string) => text.split(/\s+/).filter(Boolean);

describe("splitSentences", () => {
  it("splits on sentence-ending punctuation and trims", () => {
    expect(splitSentences("One two.  Three four!   Five six?")).toEqual([
      "One two.",
      "Three four!",
      "Five six?",
    ]);
  });

  it("keeps a final sentence that has no closing punctuation", () => {
    // A summary that ends without a full stop must still be read to the end.
    expect(splitSentences("First sentence. And then the last words")).toEqual([
      "First sentence.",
      "And then the last words",
    ]);
  });

  it("never drops or reorders a word", () => {
    const text =
      "Rates held at 4.5 percent. Was that expected? Mostly! The note ends here without a stop";
    expect(splitSentences(text).flatMap(words)).toEqual(words(text));
  });

  it("keeps closing quotes and brackets with their sentence", () => {
    expect(splitSentences('She said "hold." Then (briefly) left.')).toEqual([
      'She said "hold."',
      "Then (briefly) left.",
    ]);
  });

  it("returns nothing for empty or blank text", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   \n ")).toEqual([]);
  });
});

describe("splitSentences on long sentences", () => {
  const long =
    "The fund reported results across " +
    Array.from({ length: 40 }, (_, i) => `portfolio company number ${i + 1}`).join(", ") +
    ", and closed the quarter with no new commitments.";

  it("keeps every chunk under the limit Kokoro can render without cutting off", () => {
    expect(long.length).toBeGreaterThan(1000);
    const chunks = splitSentences(long);
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(300);
  });

  it("splits at a comma where it can and loses no words", () => {
    const chunks = splitSentences(long);
    expect(chunks.flatMap(words)).toEqual(words(long));
    for (const chunk of chunks.slice(0, -1)) expect(chunk.endsWith(",")).toBe(true);
  });

  it("falls back to spaces, then to a hard cut, when there is no comma", () => {
    expect(splitSentences("aaa bbb ccc ddd", 8)).toEqual(["aaa bbb", "ccc ddd"]);
    expect(splitSentences("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });
});
