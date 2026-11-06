/**
 * Download the pinned SpamAssassin update-channel snapshot, check its sha256,
 * recompile the rule table, and diff it against src/spamassassin/generated.ts.
 *
 * Network is used here only. The scorer never fetches rules.
 * Usage: node scripts/sa/verify.mjs [--write]
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileCfDirectory, renderGenerated, runUpstreamTests } from "./compile.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const generatedPath = path.join(root, "src/spamassassin/generated.ts");
const write = process.argv.includes("--write");

const sources = JSON.parse(fs.readFileSync(path.join(root, "vendor/spamassassin/sources.json"), "utf8"));
const pin = sources.spamassassin;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sa-rules-"));
const archivePath = path.join(tmp, `${pin.revision}.tar.gz`);
const extractPath = path.join(tmp, "extract");
fs.mkdirSync(extractPath);

const response = await fetch(pin.url, { signal: AbortSignal.timeout(120_000) });
if (!response.ok) throw new Error(`download failed: ${response.status} ${pin.url}`);
const bytes = Buffer.from(await response.arrayBuffer());
fs.writeFileSync(archivePath, bytes);
const digest = createHash("sha256").update(bytes).digest("hex");
if (digest !== pin.sha256) {
  throw new Error(`sha256 mismatch for r${pin.revision}: ${digest}`);
}
console.log(`sha256 ok r${pin.revision} ${digest}`);

const extracted = spawnSync("tar", ["-xzf", archivePath, "-C", extractPath], { encoding: "utf8" });
if (extracted.status !== 0) throw new Error(extracted.stderr || "tar failed");

function findCfDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.some((entry) => entry.isFile() && entry.name.endsWith(".cf"))) return dir;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findCfDir(path.join(dir, entry.name));
    if (found) return found;
  }
  return null;
}

const cfDir = findCfDir(extractPath);
if (!cfDir) throw new Error("snapshot contains no .cf files");
const { rules, summary } = compileCfDirectory(cfDir);
const rendered = renderGenerated(rules);
console.log(JSON.stringify({
  cfDir: path.basename(cfDir),
  totalPorted: summary.totalPorted,
  scored: summary.scored,
  disabled: summary.disabled,
  evalDeclarationCount: summary.evalDeclarationCount,
  extraDirectives: summary.extraDirectives,
  skipReasons: summary.skipReasons,
  counts: summary.counts,
}, null, 2));

const regressionPath = path.join(cfDir, "regression_tests.cf");
if (fs.existsSync(regressionPath)) {
  const upstream = runUpstreamTests(fs.readFileSync(regressionPath, "utf8"), rules);
  console.log(JSON.stringify({ upstreamTests: { pass: upstream.pass, skip: upstream.skip, fail: upstream.fail.length } }));
  if (upstream.fail.length) {
    console.log(JSON.stringify(upstream.fail.slice(0, 20), null, 2));
    throw new Error(`${upstream.fail.length} upstream regression checks failed`);
  }
}

if (write) {
  fs.writeFileSync(generatedPath, rendered);
  console.log(`wrote ${path.relative(root, generatedPath)}`);
} else if (!fs.existsSync(generatedPath) || fs.readFileSync(generatedPath, "utf8") !== rendered) {
  const mismatch = fs.existsSync(generatedPath) ? firstMismatch(fs.readFileSync(generatedPath, "utf8"), rendered) : 0;
  throw new Error(`generated.ts does not match r${pin.revision} (first difference at ${mismatch}). Run npm run sa:verify -- --write`);
} else {
  console.log("generated.ts matches the pinned snapshot");
}

function firstMismatch(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return length;
}
