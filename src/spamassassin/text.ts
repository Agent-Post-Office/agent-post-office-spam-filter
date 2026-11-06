import { PARAGRAPH_LIMIT } from "./limits.js";

const encoder = new TextEncoder();

/**
 * Latin-1 view of the UTF-8 bytes.
 * SpamAssassin patterns are byte-oriented. Matching on this string keeps
 * `\\xNN` patterns aligned with those bytes. No Node Buffer.
 */
export function bytesText(value: string): string {
  const bytes = encoder.encode(value);
  return latin1(bytes);
}

/** Latin-1 view of raw message bytes, used for header and full-message rules. */
export function rawBytes(value: Uint8Array): string {
  return latin1(value);
}

function latin1(bytes: Uint8Array): string {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return result;
}

/** Split `text` into pieces of at most `max` characters, preferring a space boundary. */
export function chunks(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ /, "");
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Blank-line paragraphs, each collapsed to one line and capped.
 * The cap is applied to the Latin-1 byte view, which is the string SpamAssassin matches.
 */
export function paragraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n[\t ]*\n/)
    .flatMap((paragraph) => chunks(bytesText(paragraph.replace(/\s+/g, " ").trim()), PARAGRAPH_LIMIT))
    .filter((paragraph) => paragraph.length > 0);
}
