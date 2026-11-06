import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entry: string) {
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const file = result.outputFiles[0];
  if (!file) throw new Error(`no bundle output for ${entry}`);
  const inputs = Object.keys(result.metafile?.inputs ?? {});
  return {
    bytes: file.contents.byteLength,
    gzipBytes: gzipSync(file.contents).byteLength,
    text: file.text,
    inputs,
  };
}

describe("package entry graph", () => {
  it("keeps the core bundle free of the SpamAssassin add-on", async () => {
    const core = await bundle("src/index.ts");
    const addon = await bundle("src/spamassassin/index.ts");
    console.log(`bundle core ${core.bytes} bytes, ${core.gzipBytes} gzip; addon ${addon.bytes} bytes, ${addon.gzipBytes} gzip`);

    expect(core.inputs.some((input) => input.includes("spamassassin"))).toBe(false);
    expect(core.inputs.some((input) => input.includes("postal-mime") || input.includes("htmlparser2"))).toBe(false);
    expect(core.inputs.some((input) => input.startsWith("node:"))).toBe(false);
    expect(core.text.includes("GTUBE-STANDARD-ANTI-UBE-TEST-EMAIL")).toBe(false);
    expect(core.text.includes("scoreSpamAssassin")).toBe(false);
    expect(core.gzipBytes).toBeLessThan(40_000);

    expect(addon.inputs.some((input) => input.includes("spamassassin/generated.ts"))).toBe(true);
    expect(addon.inputs.some((input) => input.includes("postal-mime"))).toBe(true);
    expect(addon.inputs.some((input) => input.includes("htmlparser2"))).toBe(true);
    expect(addon.inputs.some((input) => input.startsWith("node:"))).toBe(false);
    expect(addon.text.includes("GTUBE-STANDARD-ANTI-UBE-TEST-EMAIL")).toBe(true);
    expect(addon.gzipBytes).toBeGreaterThan(core.gzipBytes);
    expect(addon.gzipBytes).toBeLessThan(300_000);
  });
});
