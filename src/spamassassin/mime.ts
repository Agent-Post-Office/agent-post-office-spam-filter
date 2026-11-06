import PostalMime from "postal-mime";
import { SpamAssassinError } from "./errors.js";
import { MIME_MAX_HEADERS_SIZE, MIME_MAX_NESTING_DEPTH } from "./limits.js";

/**
 * postal-mime version this walk was written against.
 * Pinned because the fields below are not part of the public `Email` result.
 */
export const POSTAL_MIME_TREE_VERSION = "2.7.4";

const TREE_ERROR =
  `postal-mime ${POSTAL_MIME_TREE_VERSION} MIME tree is not available ` +
  "(expected parser.root, childNodes, contentType.parsed.value, and getTextContent). " +
  "Those fields are not a public API. Refusing to read the synthesized text and html fields.";

export interface TextPart {
  html: boolean;
  text: string;
}

interface MimeContentType {
  parsed?: { value?: unknown };
}

interface MimeNodeLike {
  childNodes: unknown[];
  contentType: MimeContentType;
  getTextContent?: () => unknown;
}

/**
 * Original text leaves from a parsed message.
 *
 * postal-mime's public `text` and `html` strings synthesize the missing
 * alternative (plain text becomes HTML, and HTML becomes plain text). Body
 * and rawbody hit counts would double if those strings were scanned. This
 * walks the parser's own MIME tree and keeps each text leaf once.
 * A tree that does not match postal-mime 2.7.4 throws instead of guessing.
 */
export async function readOriginalTextParts(raw: Uint8Array): Promise<TextPart[]> {
  return (await readParsedMessage(raw)).parts;
}

/** Parsed text leaves plus the decoded Subject postal-mime exposes. */
export async function readParsedMessage(raw: Uint8Array): Promise<{ parts: TextPart[]; subject: string }> {
  const parser = new PostalMime({
    maxNestingDepth: MIME_MAX_NESTING_DEPTH,
    maxHeadersSize: MIME_MAX_HEADERS_SIZE,
  });
  const email = await parser.parse(raw);
  return { parts: textPartsFromParser(parser), subject: email.subject ?? "" };
}

export function textPartsFromParser(parser: object): TextPart[] {
  if (!("root" in parser)) throw new SpamAssassinError(TREE_ERROR);
  const parts: TextPart[] = [];
  walk(parser.root, parts);
  return parts;
}

function walk(node: unknown, parts: TextPart[]): void {
  if (!isNode(node)) throw new SpamAssassinError(TREE_ERROR);
  const value = node.contentType.parsed?.value;
  if (typeof value !== "string") throw new SpamAssassinError(TREE_ERROR);
  if (node.childNodes.length === 0 && /^text\//i.test(value)) {
    if (typeof node.getTextContent !== "function") throw new SpamAssassinError(TREE_ERROR);
    const text = node.getTextContent();
    if (typeof text !== "string") throw new SpamAssassinError(TREE_ERROR);
    parts.push({ html: value.toLowerCase() === "text/html", text });
  }
  for (const child of node.childNodes) walk(child, parts);
}

function isNode(value: unknown): value is MimeNodeLike {
  if (typeof value !== "object" || value === null) return false;
  if (!("childNodes" in value) || !Array.isArray((value as { childNodes?: unknown }).childNodes)) return false;
  if (!("contentType" in value)) return false;
  const contentType = (value as { contentType?: unknown }).contentType;
  if (typeof contentType !== "object" || contentType === null || !("parsed" in contentType)) return false;
  return true;
}
