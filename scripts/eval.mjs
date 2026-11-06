/**
 * Score the committed synthetic corpus.
 *
 * The checked verdict is the core score plus the default SpamAssassin fold.
 * A fixture may disagree with its label only when it sets `expected`.
 * `expectedCounts` must match the false-positive and false-negative totals.
 *
 * Usage: node scripts/eval.mjs
 * Addresses in the corpus must use example.com, example.org, example.net,
 * or the single-label domain invalid. This script refuses anything else.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PostalMime from "postal-mime";
import { scoreMessage } from "../dist/index.js";
import { foldSpamAssassin, scoreSpamAssassin } from "../dist/spamassassin/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpusDir = path.join(root, "test", "corpus");
const manifestPath = path.join(corpusDir, "manifest.json");

const ADDRESS = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)/g;

function domainAllowed(domain) {
  const normalized = domain.toLowerCase().replace(/\.+$/, "");
  if (normalized === "invalid") return true;
  if (normalized === "example.com" || normalized === "example.org" || normalized === "example.net") return true;
  return (
    normalized.endsWith(".example.com") ||
    normalized.endsWith(".example.org") ||
    normalized.endsWith(".example.net")
  );
}

function unexpectedAddresses(text) {
  const found = [];
  for (const match of text.matchAll(ADDRESS)) {
    const domain = match[1];
    if (!domain || domainAllowed(domain)) continue;
    found.push(match[0]);
  }
  return found;
}

function mailbox(address) {
  if (!address) return null;
  if ("group" in address && address.group) return address.group[0] ?? null;
  return address.address ? address : null;
}

function formatMailbox(address) {
  const box = mailbox(address);
  if (!box?.address) return "";
  if (box.name) return `${box.name} <${box.address}>`;
  return box.address;
}

function emptyLists() {
  return { allowSenders: [], blockSenders: [], allowDomains: [], blockDomains: [] };
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function matrix(rows) {
  const labels = ["ham", "spam"];
  const counts = { ham: { ham: 0, spam: 0 }, spam: { ham: 0, spam: 0 } };
  for (const row of rows) counts[row.label][row.verdict] += 1;
  const lines = [
    `${pad("label \\ verdict", 18)}${pad("ham", 8)}${pad("spam", 8)}`,
    ...labels.map((label) => `${pad(label, 18)}${pad(counts[label].ham, 8)}${pad(counts[label].spam, 8)}`),
  ];
  return { counts, text: lines.join("\n") };
}

function fail(problems) {
  console.log("");
  for (const problem of problems) console.log(`FAIL ${problem}`);
  process.exitCode = 1;
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (!manifest || !Array.isArray(manifest.messages)) throw new Error("manifest.messages must be an array");
if (!Number.isInteger(manifest.threshold)) throw new Error("manifest.threshold must be an integer");
const expectedCounts = manifest.expectedCounts;
if (!expectedCounts || !Number.isInteger(expectedCounts.falsePositive) || !Number.isInteger(expectedCounts.falseNegative)) {
  throw new Error("manifest.expectedCounts.falsePositive and falseNegative must be integers");
}

const seenIds = new Set();
const seenFiles = new Set();
const problems = [];
const rows = [];

for (const message of manifest.messages) {
  if (!message || typeof message.id !== "string" || !/^[a-z0-9-]+$/.test(message.id)) {
    problems.push("a fixture id is missing or not a lowercase slug");
    continue;
  }
  if (seenIds.has(message.id)) problems.push(`${message.id}: duplicate id`);
  seenIds.add(message.id);
  if (message.label !== "ham" && message.label !== "spam") problems.push(`${message.id}: label must be ham or spam`);
  if (message.source !== "synthetic") problems.push(`${message.id}: source must be synthetic`);
  if (typeof message.reason !== "string" || message.reason.trim() === "") problems.push(`${message.id}: reason is required`);
  if (typeof message.file !== "string" || message.file.includes("..") || path.isAbsolute(message.file)) {
    problems.push(`${message.id}: file must be a relative path inside test/corpus`);
    continue;
  }
  if (seenFiles.has(message.file)) problems.push(`${message.id}: duplicate file ${message.file}`);
  seenFiles.add(message.file);
  if (typeof message.authenticationResults !== "string") problems.push(`${message.id}: authenticationResults must be a string`);
  if (typeof message.recipientDomain !== "string" || message.recipientDomain.trim() === "") {
    problems.push(`${message.id}: recipientDomain is required`);
  }

  const filePath = path.resolve(corpusDir, message.file);
  if (filePath !== corpusDir && !filePath.startsWith(`${corpusDir}${path.sep}`)) {
    problems.push(`${message.id}: file escapes test/corpus`);
    continue;
  }
  if (!fs.existsSync(filePath)) {
    problems.push(`${message.id}: missing ${message.file}`);
    continue;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const stray = [
    ...unexpectedAddresses(raw),
    ...unexpectedAddresses(JSON.stringify({
      authenticationResults: message.authenticationResults,
      recipientDomain: message.recipientDomain,
      lists: message.lists ?? {},
    })),
  ];
  if (stray.length > 0) problems.push(`${message.id}: address outside example.com, example.org, example.net, or invalid: ${stray.join(", ")}`);

  const email = await PostalMime.parse(raw);
  const from = formatMailbox(email.from);
  if (!from) problems.push(`${message.id}: no From address`);
  const text = email.text ?? "";
  const subject = email.subject ?? "";
  const lists = { ...emptyLists(), ...(message.lists ?? {}) };
  const core = scoreMessage(
    {
      from,
      subject,
      text,
      authenticationResults: message.authenticationResults,
      recipientDomain: message.recipientDomain,
    },
    { threshold: manifest.threshold, lists },
  );
  const sa = await scoreSpamAssassin(raw);
  const folded = foldSpamAssassin(core, sa, { threshold: manifest.threshold });

  let disposition = "ok";
  if (message.expected != null) {
    const expected = message.expected;
    if (!expected || (expected.verdict !== "ham" && expected.verdict !== "spam")) {
      problems.push(`${message.id}: expected.verdict must be ham or spam`);
    } else if (typeof expected.reason !== "string" || expected.reason.trim() === "") {
      problems.push(`${message.id}: expected.reason is required`);
    } else if (expected.verdict === message.label) {
      problems.push(`${message.id}: expected is only for a verdict that differs from the label`);
    } else if (folded.verdict !== expected.verdict) {
      problems.push(`${message.id}: folded verdict ${folded.verdict}, expected ${expected.verdict}`);
      disposition = "FAIL";
    } else {
      disposition = message.label === "spam" ? "known-fn" : "known-fp";
    }
  } else if (folded.verdict !== message.label) {
    problems.push(`${message.id}: folded verdict ${folded.verdict}, label ${message.label}`);
    disposition = "FAIL";
  }

  rows.push({
    id: message.id,
    label: message.label,
    reason: message.reason,
    expectedReason: message.expected?.reason ?? "",
    coreScore: core.score,
    coreVerdict: core.verdict,
    coreReasons: core.reasons.join(","),
    saScore: sa.score,
    saHits: sa.hits.map((hit) => hit.name).join(","),
    score: folded.score,
    verdict: folded.verdict,
    disposition,
  });
}

const ham = rows.filter((row) => row.label === "ham").length;
const spam = rows.filter((row) => row.label === "spam").length;
const falsePositives = rows.filter((row) => row.label === "ham" && row.verdict === "spam").length;
const falseNegatives = rows.filter((row) => row.label === "spam" && row.verdict === "ham").length;
if (falsePositives !== expectedCounts.falsePositive) {
  problems.push(`false positives ${falsePositives}, expectedCounts.falsePositive ${expectedCounts.falsePositive}`);
}
if (falseNegatives !== expectedCounts.falseNegative) {
  problems.push(`false negatives ${falseNegatives}, expectedCounts.falseNegative ${expectedCounts.falseNegative}`);
}

const idWidth = Math.max(2, ...rows.map((row) => row.id.length));
console.log(`fixtures ${rows.length}  ham ${ham}  spam ${spam}  threshold ${manifest.threshold}`);
console.log("verdict = core score + default SpamAssassin fold");
console.log("");
console.log(
  `${pad("id", idWidth)}  label  core        sa        folded      result`,
);
for (const row of rows) {
  const core = `${row.coreScore}/${row.coreVerdict}`;
  const sa = row.saScore.toFixed(3);
  const folded = `${row.score}/${row.verdict}`;
  console.log(
    `${pad(row.id, idWidth)}  ${pad(row.label, 5)}  ${pad(core, 10)}  ${pad(sa, 8)}  ${pad(folded, 10)}  ${row.disposition}`,
  );
}

const coreRows = rows.map((row) => ({ label: row.label, verdict: row.coreVerdict }));
console.log("");
console.log("confusion matrix, core only");
console.log(matrix(coreRows).text);
console.log("");
console.log("confusion matrix, core + SpamAssassin fold");
const foldedMatrix = matrix(rows);
console.log(foldedMatrix.text);
console.log("");
console.log(`false positives ${falsePositives} (expected ${expectedCounts.falsePositive})`);
console.log(`false negatives ${falseNegatives} (expected ${expectedCounts.falseNegative})`);

const misses = rows.filter((row) => row.disposition === "known-fn" || row.disposition === "known-fp");
console.log("");
console.log(misses.length === 0 ? "known misses: none" : "known misses:");
for (const row of misses) {
  console.log(`- ${row.id}: label ${row.label}, verdict ${row.verdict}. ${row.expectedReason}`);
}

if (problems.length > 0) fail(problems);
