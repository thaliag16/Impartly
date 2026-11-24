// Splits text into the chunks Kokoro renders one at a time.
//
// Kokoro cuts off long input: kokoro-js tokenizes with truncation on, so anything past
// the model's 512-token context (about 400 characters of English) is silently dropped.
// Rendering sentence by sentence keeps every chunk well inside that limit, and
// MAX_CHUNK_CHARS splits the rare sentence that is still too long.
//
// Used by the voice spike (app/spike/voice), the speech-test route and the model tests.

export const MAX_CHUNK_CHARS = 300;

// A sentence ends at . ! or ?, plus any closing quotes or brackets, followed by
// whitespace. "4.5" and "U.S.-based" do not end a sentence; a final sentence with no
// closing punctuation is kept.
const SENTENCE_BREAK = /(?<=[.!?]+["'”’)\]]*)\s+/;

export function splitSentences(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  return text
    .split(SENTENCE_BREAK)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .flatMap((sentence) => splitLong(sentence, maxChars));
}

// Splits at the last comma, semicolon, colon or dash before the limit, else at the
// last space, else (one enormous word) at the limit itself.
function splitLong(sentence: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let rest = sentence;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1);
    let cut = Math.max(
      window.lastIndexOf(", "),
      window.lastIndexOf("; "),
      window.lastIndexOf(": "),
      window.lastIndexOf(" - "),
    );
    cut = cut > maxChars / 3 ? cut + 1 : window.lastIndexOf(" ");
    if (cut <= 0) cut = maxChars;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
