/**
 * Score the pinned SpamAssassin public corpora.
 *
 * Opt-in. The messages are downloaded, checked, scored, and discarded.
 * They are not committed. Output is aggregate counts, plus filenames and
 * hit names when --list is passed. Message text is never printed.
 *
 * Usage: node scripts/eval-public.mjs [--list]
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreSpamAssassin } from "../dist/spamassassin/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const listHits = process.argv.includes("--list");
const sources = JSON.parse(fs.readFileSync(path.join(root, "vendor/spamassassin/sources.json"), "utf8"));
const corpora = sources.publicCorpus;
if (!Array.isArray(corpora) || corpora.length === 0) throw new Error("sources.json publicCorpus is missing");

const cacheDir = path.join(root, "vendor", "spamassassin", "corpus");
fs.mkdirSync(cacheDir, { recursive: true });

async function archiveBytes(corpus) {
  const cached = path.join(cacheDir, corpus.file);
  if (fs.existsSync(cached)) {
    const bytes = fs.readFileSync(cached);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest === corpus.sha256) return bytes;
    console.log(`replacing ${corpus.file}: cached sha256 ${digest}`);
  }
  const response = await fetch(corpus.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`download failed: ${response.status} ${corpus.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== corpus.sha256) throw new Error(`sha256 mismatch for ${corpus.id}: ${digest}`);
  fs.writeFileSync(cached, bytes);
  return bytes;
}

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function looksLikeMessage(bytes) {
  const head = bytes.subarray(0, 4000).toString("latin1");
  return /^From:/im.test(head) || /\nFrom:/i.test(head);
}

let failed = false;
for (const corpus of corpora) {
  const bytes = await archiveBytes(corpus);
  const digest = createHash("sha256").update(bytes).digest("hex");
  console.log(`sha256 ok ${corpus.id} ${digest}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `sa-corpus-${corpus.id}-`));
  const archivePath = path.join(tmp, corpus.file);
  const extractPath = path.join(tmp, "extract");
  fs.mkdirSync(extractPath);
  fs.writeFileSync(archivePath, bytes);
  const extracted = spawnSync("tar", ["-xjf", archivePath, "-C", extractPath], { encoding: "utf8" });
  if (extracted.status !== 0) throw new Error(extracted.stderr || `tar failed for ${corpus.id}`);

  let scored = 0;
  let skipped = 0;
  let ge5 = 0;
  const listed = [];
  for (const file of walk(extractPath)) {
    const raw = fs.readFileSync(file);
    if (!looksLikeMessage(raw)) {
      skipped += 1;
      continue;
    }
    let sa;
    try {
      sa = await scoreSpamAssassin(raw);
    } catch (error) {
      const relative = path.relative(extractPath, file);
      throw new Error(`${corpus.id} ${relative} failed to score: ${error instanceof Error ? error.name : "Error"}`);
    }
    scored += 1;
    if (sa.score >= 5) {
      ge5 += 1;
      if (listHits) {
        const relative = path.relative(extractPath, file).split(path.sep).join("/");
        listed.push(`${relative} ${sa.score.toFixed(3)} ${sa.hits.map((hit) => hit.name).join(",")}`);
      }
    }
  }
  console.log(
    `${corpus.id} scored ${scored} skipped ${skipped} native>=5 ${ge5} (expected scored ${corpus.scored}, native>=5 ${corpus.nativeAtLeast5})`,
  );
  if (scored !== corpus.scored || ge5 !== corpus.nativeAtLeast5) {
    console.log(`FAIL ${corpus.id} counts differ from vendor/spamassassin/sources.json`);
    failed = true;
  }
  if (listHits) {
    listed.sort();
    for (const line of listed) console.log(line);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failed) process.exitCode = 1;
