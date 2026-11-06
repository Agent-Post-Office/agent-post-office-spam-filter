import { addressParser, decodeWords } from "postal-mime";
import { SpamAssassinError } from "./errors.js";
import { renderHtml } from "./html.js";
import { RAWBODY_CHAR_LIMIT, RAWBODY_CHUNK_LIMIT, SPAMASSASSIN_RAW_BYTE_LIMIT, TEXT_PART_CHAR_LIMIT } from "./limits.js";
import { evaluate } from "./meta.js";
import { readParsedMessage } from "./mime.js";
import { rules } from "./generated.js";
import type { Rule } from "./model.js";
import { bytesText, chunks, paragraphs, rawBytes } from "./text.js";

export interface SpamAssassinHit {
  /** Rule name from the SpamAssassin snapshot. Names starting with `__` are subrules and are omitted. */
  name: string;
  /** Points added to {@link SpamAssassinScore.score}. Already multiplied when a rule matches more than once. */
  score: number;
}

export interface SpamAssassinScore {
  /** Sum of SpamAssassin rule points, including negative ham rules. Not on the core 0-100 scale. */
  score: number;
  hits: SpamAssassinHit[];
  /**
   * Rules that were not run because `knownHeaders` or `incompleteBody` said the evidence was missing.
   * Omitted when every rule was run. A skipped rule is not treated as a miss.
   */
  skipped?: string[];
}

export interface ScoreSpamAssassinOptions {
  /**
   * Header names the caller actually has, compared case-insensitively.
   * Rules for any other header are skipped, so a missing header is not scored as absent.
   * `ALL` and full-message rules are skipped too: they read the whole header block or message.
   */
  knownHeaders?: readonly string[];
  /**
   * Skip body, rawbody, uri, and full rules. Header rules still run.
   * A meta rule runs only when every dependency ran.
   */
  incompleteBody?: boolean;
}

export type RawMessage = string | ArrayBuffer | Uint8Array;

interface CompiledRule {
  rule: Rule;
  regexp: RegExp | null;
}

// One RegExp per rule, shared by every call. The match loop below is synchronous,
// so two overlapping calls cannot interleave a `lastIndex` update.
const compiled: CompiledRule[] = rules.map((rule) => ({ rule, regexp: regexpFor(rule) }));

function regexpFor(rule: Rule): RegExp | null {
  if (rule.kind === "meta" || (rule.kind === "header" && rule.exists)) return null;
  if (typeof rule.source !== "string") throw new Error(`missing regex source for ${rule.name}`);
  const flags = `${rule.flags ?? ""}${rule.multiple ? "g" : ""}`;
  return new RegExp(rule.source, flags);
}

function toBytes(raw: RawMessage): Uint8Array {
  if (typeof raw === "string") return new TextEncoder().encode(raw);
  if (raw instanceof Uint8Array) return raw;
  return new Uint8Array(raw);
}

/**
 * Score one raw RFC5322 message with the pinned SpamAssassin rule subset.
 *
 * `raw` is the message bytes, or the same bytes decoded as a string.
 * Points are SpamAssassin's own. The core threshold of 60 is not applied here.
 * There is no network I/O. Messages larger than {@link SPAMASSASSIN_RAW_BYTE_LIMIT} throw.
 */
export async function scoreSpamAssassin(raw: RawMessage, options: ScoreSpamAssassinOptions = {}): Promise<SpamAssassinScore> {
  const bytes = toBytes(raw);
  if (bytes.byteLength > SPAMASSASSIN_RAW_BYTE_LIMIT) {
    throw new SpamAssassinError(
      `raw message is ${bytes.byteLength} bytes; the limit is ${SPAMASSASSIN_RAW_BYTE_LIMIT}`,
    );
  }

  const parsed = await readParsedMessage(bytes);
  const parts = parsed.parts;
  const rawString = rawBytes(bytes);
  const headerBlock = rawString.split(/\r?\n\r?\n/, 1)[0] ?? "";
  const rawHeaders = new Map<string, string[]>();
  for (const line of headerBlock.split(/\r?\n(?![\t ])/)) {
    const match = /^([^:\s]+):[\t ]?(.*)$/s.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const values = rawHeaders.get(key);
    if (values) values.push(match[2] ?? "");
    else rawHeaders.set(key, [match[2] ?? ""]);
  }
  rawHeaders.set("__all", [headerBlock]);

  const known = options.knownHeaders ? new Set(options.knownHeaders.map((name) => name.toLowerCase())) : null;
  const visible = parts
    .map((part) => (part.html ? renderHtml(part.text) : part.text))
    .filter((text) => text.length > 0)
    .map((text) => text.slice(0, TEXT_PART_CHAR_LIMIT));
  const body = visible.flatMap(paragraphs);
  const subject = bytesText(parsed.subject);
  const rawbody = parts
    .map((part) => part.text)
    .filter((text) => text.length > 0)
    .flatMap((text) => chunks(bytesText(text.slice(0, RAWBODY_CHAR_LIMIT)), RAWBODY_CHUNK_LIMIT));
  const urls = uniqueUrls(parts.map((part) => part.text).join("\n")).map(bytesText);

  const values = new Map<string, number>();
  const skipped: string[] = [];
  const hits: SpamAssassinHit[] = [];
  let score = 0;

  for (const { rule, regexp } of compiled) {
    if (rule.disabled) {
      values.set(rule.name, 0);
      continue;
    }
    if (rule.kind === "meta") {
      if (rule.deps.some((dep) => skipped.includes(dep))) {
        skipped.push(rule.name);
        continue;
      }
      const value = evaluate(rule.ast, values);
      values.set(rule.name, value);
      if (value && !rule.name.startsWith("__")) {
        score += rule.score;
        hits.push({ name: rule.name, score: rule.score });
      }
      continue;
    }

    if (options.incompleteBody && rule.kind !== "header") {
      skipped.push(rule.name);
      continue;
    }

    let targets: string[] = [];
    if (rule.kind === "header") {
      const names = headerNames(rule.header);
      if (known && (rule.header.split(":")[0] === "ALL" || !names.some((name) => known.has(name)))) {
        skipped.push(rule.name);
        continue;
      }
      const value = headerValue(rule.header, rawHeaders);
      if (rule.exists) {
        const present = value !== undefined;
        values.set(rule.name, Number(present));
        if (present && !rule.name.startsWith("__")) {
          score += rule.score;
          hits.push({ name: rule.name, score: rule.score });
        }
        continue;
      }
      targets = [value ?? rule.ifUnset ?? ""];
    } else if (rule.kind === "body") {
      targets = rule.nosubject ? body : [subject, ...body];
    } else if (rule.kind === "rawbody") {
      targets = rawbody;
    } else if (rule.kind === "uri") {
      targets = urls;
    } else if (known) {
      skipped.push(rule.name);
      continue;
    } else {
      targets = [rawString];
    }

    if (!regexp) throw new Error(`missing compiled regex for ${rule.name}`);
    let count = matchCount(regexp, targets, rule.multiple, rule.maxhits);
    if (rule.kind === "header" && rule.negate) count = Number(!count);
    values.set(rule.name, count);
    if (count && !rule.name.startsWith("__")) {
      const contributed = rule.score * count;
      score += contributed;
      hits.push({ name: rule.name, score: contributed });
    }
  }

  const result: SpamAssassinScore = { score, hits };
  if (skipped.length > 0) result.skipped = skipped;
  return result;
}

function headerNames(header: string): string[] {
  const token = header.split(":")[0] ?? "";
  if (token === "ToCc") return ["to", "cc"];
  if (token === "MESSAGEID") return ["message-id", "resent-message-id", "x-message-id"];
  return [token.toLowerCase()];
}

function headerValue(header: string, raw: ReadonlyMap<string, string[]>): string | undefined {
  if (header.split(":")[0] === "ALL") {
    const value = (raw.get("__all") ?? []).join("\n");
    return header.includes(":raw") ? value : value.replace(/\r?\n[\t ]+/g, " ");
  }
  const found = headerNames(header).flatMap((name) => raw.get(name) ?? []);
  if (!found.length) return undefined;
  let value = found.join("\n");
  if (header.includes(":addr") || header.includes(":name")) {
    const address = addressParser(value, { flatten: true })[0];
    if (!address) return "";
    if (header.includes(":name")) return address.name;
    return "address" in address ? address.address ?? "" : "";
  }
  if (!header.includes(":raw")) value = decodeWords(value.replace(/\r?\n[\t ]+/g, " "));
  return value;
}

function matchCount(regexp: RegExp, targets: readonly string[], multiple: boolean, maxhits: number): number {
  let count = 0;
  for (const target of targets) {
    regexp.lastIndex = 0;
    if (!multiple) {
      if (regexp.test(target)) return 1;
      continue;
    }
    let match: RegExpExecArray | null;
    while ((match = regexp.exec(target)) && count < maxhits) {
      count += 1;
      if (!match[0]) regexp.lastIndex += 1;
    }
    if (count >= maxhits) break;
  }
  return count;
}

function uniqueUrls(text: string): string[] {
  const found = text.match(/(?:https?|ftp):\/\/[^\s<>"']+|mailto:[^\s<>"']+/gi) ?? [];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const url of found) {
    let decoded = url.replace(/&amp;/g, "&").replace(/[).,;]+$/, "");
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Keep the raw match when the percent-encoding is not valid UTF-8.
    }
    if (seen.has(decoded)) continue;
    seen.add(decoded);
    urls.push(decoded);
  }
  return urls;
}
