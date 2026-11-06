import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scoreMessage, scoreSpam, type SpamLists } from "../src/index.js";
import { POSTAL_MIME_TREE_VERSION } from "../src/spamassassin/mime.js";
import { evaluate } from "../src/spamassassin/meta.js";
import { readOriginalTextParts } from "../src/spamassassin/mime.js";
import { renderHtml } from "../src/spamassassin/html.js";
import { paragraphs } from "../src/spamassassin/text.js";
import {
  SPAMASSASSIN_CORE_CAP,
  SPAMASSASSIN_GTUBE_RULE,
  SPAMASSASSIN_RAW_BYTE_LIMIT,
  SPAMASSASSIN_STANDALONE_SPAM_SCORE,
  SPAMASSASSIN_THRESHOLD,
  SpamAssassinError,
  foldSpamAssassin,
  scoreSpamAssassin,
  spamAssassinCorePoints,
} from "../src/spamassassin/index.js";

const GTUBE = "XJS*C4JDBQADN1.NSBN3*2IDNEN*GTUBE-STANDARD-ANTI-UBE-TEST-EMAIL*C.34X";

const EMPTY_LISTS: SpamLists = {
  allowSenders: [],
  blockSenders: [],
  allowDomains: [],
  blockDomains: [],
};

function message(options: {
  subject?: string;
  body?: string;
  contentType?: string;
  extraHeaders?: string[];
  encoding?: string;
} = {}): Uint8Array {
  const headers = [
    "From: Alice <alice@example.com>",
    "To: Bob <bob@example.com>",
    "Subject: " + (options.subject ?? "Lunch on Friday"),
    "Date: Fri, 06 Nov 2026 10:00:00 +0000",
    "Message-ID: <lunch-friday@example.com>",
    "MIME-Version: 1.0",
    `Content-Type: ${options.contentType ?? "text/plain"}; charset=UTF-8`,
  ];
  if (options.encoding) headers.push(`Content-Transfer-Encoding: ${options.encoding}`);
  for (const header of options.extraHeaders ?? []) headers.push(header);
  return new TextEncoder().encode(`${headers.join("\r\n")}\r\n\r\n${options.body ?? "Hi Bob, lunch on Friday still works for me."}`);
}

describe("SpamAssassin text preparation", () => {
  it("joins wrapped lines, splits paragraphs, and caps each paragraph at 2048 bytes", () => {
    expect(paragraphs("one\n two\n\nthree\tfour")).toEqual(["one two", "three four"]);
    expect(paragraphs("x".repeat(5000)).every((paragraph) => paragraph.length <= 2048)).toBe(true);
  });

  it("decodes HTML entities, keeps block breaks, and drops script and style text", () => {
    expect(renderHtml("<p>Meeting &amp; agenda</p><p>Tomorrow</p><script>spam</script>")).toMatch(/Meeting & agenda\n\n/);
    expect(renderHtml("<style>spam</style>hello").includes("spam")).toBe(false);
  });

  it("reads each original text leaf once", async () => {
    const plain = await readOriginalTextParts(message({ body: "one simple paragraph" }));
    expect(plain).toHaveLength(1);
    expect(plain[0]?.html).toBe(false);
    expect(plain[0]?.text.trim()).toBe("one simple paragraph");

    const html = await readOriginalTextParts(message({
      contentType: "text/html",
      body: "<p>one simple paragraph</p>",
    }));
    expect(html).toHaveLength(1);
    expect(html[0]?.html).toBe(true);
    expect(html[0]?.text).toContain("one simple paragraph");

    const alternative = [
      "From: Alice <alice@example.com>",
      "To: Bob <bob@example.com>",
      "Subject: Lunch on Friday",
      "Date: Fri, 06 Nov 2026 10:00:00 +0000",
      "Message-ID: <lunch-friday@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: multipart/alternative; boundary=bound",
      "",
      "--bound",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "Hello plain",
      "--bound",
      "Content-Type: text/html; charset=UTF-8",
      "",
      "<p>Hello html</p>",
      "--bound--",
      "",
    ].join("\r\n");
    const parts = await readOriginalTextParts(new TextEncoder().encode(alternative));
    expect(parts.map((part) => part.html)).toEqual([false, true]);
    expect(parts.map((part) => part.text.trim())).toEqual(["Hello plain", "<p>Hello html</p>"]);
  });
});

describe("scoreSpamAssassin", () => {
  it("scores the GTUBE fixture in the body, the subject, and a base64 part", async () => {
    const body = await scoreSpamAssassin(message({ body: GTUBE }));
    expect(body.hits.some((hit) => hit.name === "GTUBE" && hit.score === 1000)).toBe(true);
    expect(body.score).toBeGreaterThanOrEqual(1000);
    expect(body.skipped).toBeUndefined();

    const subject = await scoreSpamAssassin(message({ subject: GTUBE, body: "ordinary note" }));
    expect(subject.hits.some((hit) => hit.name === "GTUBE")).toBe(true);

    const encoded = message({
      encoding: "base64",
      body: Buffer.from(GTUBE, "utf8").toString("base64"),
    });
    const decoded = await scoreSpamAssassin(encoded);
    expect(decoded.hits.some((hit) => hit.name === "GTUBE")).toBe(true);

    const asString = await scoreSpamAssassin(new TextDecoder().decode(message({ body: GTUBE })));
    expect(asString.score).toBe(body.score);
  });

  it("keeps a short example.com note under the native threshold", async () => {
    const result = await scoreSpamAssassin(message());
    expect(result.score).toBeLessThan(SPAMASSASSIN_THRESHOLD);
    expect(result.hits.some((hit) => hit.name === "GTUBE")).toBe(false);
    expect(result.hits.some((hit) => hit.name === "MSGID_HDR_MALF")).toBe(false);
  });

  it("does not invent missing-header hits for a partial header set", async () => {
    const result = await scoreSpamAssassin(message(), { knownHeaders: ["from", "subject"] });
    expect(result.skipped?.length).toBeGreaterThan(0);
    expect(result.hits.some((hit) => /MISSING|NO_RELAYS|NO_RECEIVED/.test(hit.name))).toBe(false);
  });

  it("skips body rules when the body is incomplete and still scores header evidence", async () => {
    const result = await scoreSpamAssassin(message({ body: GTUBE }), { incompleteBody: true });
    expect(result.hits.some((hit) => hit.name === "GTUBE")).toBe(false);
    expect(result.skipped?.some((name) => name === "GTUBE")).toBe(true);
  });

  it("hides GTUBE placed only inside a script element", async () => {
    const hidden = await scoreSpamAssassin(message({
      contentType: "text/html",
      body: `<html><body><script>${GTUBE}</script><p>Hello</p></body></html>`,
    }));
    expect(hidden.hits.some((hit) => hit.name === "GTUBE")).toBe(false);

    const visible = await scoreSpamAssassin(message({
      contentType: "text/html",
      body: `<html><body><p>${GTUBE}</p></body></html>`,
    }));
    expect(visible.hits.some((hit) => hit.name === "GTUBE")).toBe(true);
  });

  it("refuses a raw message over 2 MB before matching", async () => {
    const oversized = "x".repeat(SPAMASSASSIN_RAW_BYTE_LIMIT + 1);
    await expect(scoreSpamAssassin(oversized)).rejects.toBeInstanceOf(SpamAssassinError);
  });
});

describe("foldSpamAssassin", () => {
  const ham = () => scoreMessage({
    from: "alice@example.com",
    subject: "Lunch on Friday",
    text: "Hi Bob, lunch on Friday still works for me.",
    authenticationResults: null,
    recipientDomain: "example.com",
  });

  it("adds capped points below the standalone score and does not flag on that alone", () => {
    expect(spamAssassinCorePoints(4.6)).toBe(0);
    expect(spamAssassinCorePoints(5)).toBe(5);
    expect(spamAssassinCorePoints(5.5)).toBe(6);
    expect(spamAssassinCorePoints(9.4)).toBe(9);
    expect(spamAssassinCorePoints(9.6)).toBe(10);
    expect(spamAssassinCorePoints(-4)).toBe(0);
    expect(spamAssassinCorePoints(1000)).toBe(SPAMASSASSIN_CORE_CAP);
    expect(spamAssassinCorePoints(1000, 10)).toBe(10);
    expect(SPAMASSASSIN_CORE_CAP).toBeLessThan(60);
    expect(SPAMASSASSIN_STANDALONE_SPAM_SCORE).toBe(10);

    const plain = ham();
    expect(plain).toEqual({ score: 0, reasons: [], verdict: "ham" });
    expect(foldSpamAssassin(plain, { score: 4.9 })).toBe(plain);

    expect(foldSpamAssassin(plain, { score: 9.6 })).toEqual({
      score: 10,
      reasons: ["spamassassin"],
      verdict: "ham",
    });
    expect(foldSpamAssassin(plain, { score: 5 })).toEqual({
      score: 5,
      reasons: ["spamassassin"],
      verdict: "ham",
    });
  });

  it("flags a GTUBE hit even when the core score is 0", () => {
    const flagged = foldSpamAssassin(ham(), {
      score: 1000,
      hits: [{ name: SPAMASSASSIN_GTUBE_RULE, score: 1000 }],
    });
    expect(flagged).toEqual({ score: SPAMASSASSIN_CORE_CAP, reasons: ["spamassassin"], verdict: "spam" });

    const withCorePoints = foldSpamAssassin(
      { score: 8, reasons: ["urgency_notice"], verdict: "ham" },
      { score: 1000, hits: [{ name: "GTUBE" }] },
    );
    expect(withCorePoints).toEqual({ score: 60, reasons: ["urgency_notice", "spamassassin"], verdict: "spam" });
  });

  it("flags a native score of 10 or more on its own and leaves 9.x ham", () => {
    const plain = ham();
    expect(foldSpamAssassin(plain, { score: 10 })).toEqual({
      score: 10,
      reasons: ["spamassassin"],
      verdict: "spam",
    });
    expect(foldSpamAssassin(plain, { score: 9.9 })).toEqual({
      score: 10,
      reasons: ["spamassassin"],
      verdict: "ham",
    });
    expect(foldSpamAssassin(plain, { score: 20 }, { standaloneSpamScore: null })).toEqual({
      score: 20,
      reasons: ["spamassassin"],
      verdict: "ham",
    });
  });

  it("lets a GTUBE hit override an allow decision and leaves other list decisions in place", () => {
    const allowed = scoreSpam({
      from: "alice@example.com",
      subject: GTUBE,
      text: GTUBE,
      authenticationResults: null,
      recipientDomain: "example.com",
      lists: { ...EMPTY_LISTS, allowSenders: ["alice@example.com"] },
      threshold: 60,
    });
    expect(allowed.verdict).toBe("ham");
    expect(foldSpamAssassin(allowed, { score: 15 })).toEqual(allowed);
    expect(foldSpamAssassin(allowed, { score: 1000, hits: [{ name: "GTUBE", score: 1000 }] })).toEqual({
      score: SPAMASSASSIN_CORE_CAP,
      reasons: ["spamassassin"],
      verdict: "spam",
    });
    expect(foldSpamAssassin(allowed, { score: 1000, hits: [{ name: "GTUBE" }] }, { gtubeAlwaysSpam: false })).toEqual(allowed);

    const blocked = scoreSpam({
      from: "alice@example.com",
      subject: "Hello",
      text: "Hi",
      authenticationResults: null,
      recipientDomain: "example.com",
      lists: { ...EMPTY_LISTS, blockSenders: ["alice@example.com"] },
      threshold: 60,
    });
    expect(foldSpamAssassin(blocked, { score: 1000, hits: [{ name: "GTUBE" }] })).toEqual(blocked);
  });

  it("uses the caller's core threshold for native scores below the standalone line", () => {
    const assessment = { score: 0, reasons: [], verdict: "ham" as const };
    expect(foldSpamAssassin(assessment, { score: 8 }, { threshold: 5 }).verdict).toBe("spam");
    expect(foldSpamAssassin(assessment, { score: 8 }, { threshold: 30 }).verdict).toBe("ham");
    expect(foldSpamAssassin(assessment, { score: 20 }, { threshold: 30 }).verdict).toBe("spam");
  });
});

describe("pinned MIME dependencies", () => {
  it("matches the postal-mime tree walk and the htmlparser2 pin", () => {
    const version = (name: string) => {
      const file = path.join("node_modules", name, "package.json");
      return (JSON.parse(fs.readFileSync(file, "utf8")) as { version: string }).version;
    };
    expect(version("postal-mime")).toBe(POSTAL_MIME_TREE_VERSION);
    expect(version("htmlparser2")).toBe("10.0.0");
  });
});

describe("meta evaluation", () => {
  it("returns the right operand for && and 0 for division by zero", () => {
    const empty = new Map<string, number>();
    expect(evaluate({
      kind: "binary",
      op: "&&",
      left: { kind: "number", value: 2 },
      right: { kind: "number", value: 3 },
    }, empty)).toBe(3);
    expect(evaluate({
      kind: "binary",
      op: "/",
      left: { kind: "number", value: 1 },
      right: { kind: "number", value: 0 },
    }, empty)).toBe(0);
    expect(evaluate({ kind: "unary", op: "!", value: { kind: "number", value: 0 } }, empty)).toBe(1);
  });
});
