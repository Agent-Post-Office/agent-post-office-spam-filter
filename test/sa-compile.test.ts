import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { compileCfSources, CONDITIONAL_VERSION, translateRegex } from "../scripts/sa/compile.mjs";
import { rules } from "../src/spamassassin/generated.js";

describe("SpamAssassin rule compiler", () => {
  it("translates POSIX classes, anchors, quoting, and the x flag", () => {
    const digits = translateRegex("/[[:digit:]]+\\z/");
    expect(digits).toEqual({ source: "[0-9]+(?![\\s\\S])", flags: "", extra: "" });
    expect(new RegExp(digits.source).test("123")).toBe(true);
    expect(new RegExp(digits.source).test("123a")).toBe(false);

    expect(translateRegex("/\\Afoo\\h/").source).toBe("(?<![\\s\\S])foo[\\t ]");
    expect(translateRegex("/\\v/").source).toBe("[\\n\\r\\f\\x0b]");
    expect(translateRegex("/a\\Q.+\\Eb/").source).toBe("a\\.\\+b");
    expect(translateRegex("/a b # comment\\nc/x").source).toBe("ab");
    expect(translateRegex("/foo/i")).toMatchObject({ source: "foo", flags: "i" });
  });

  it("rejects Perl regex features the runtime does not implement", () => {
    expect(() => translateRegex("/(?<=a)/")).toThrow(/lookbehind/);
    expect(() => translateRegex("/a++/")).toThrow(/possessive/);
    expect(() => translateRegex("/\\p{L}/")).toThrow(/Perl property/);
    expect(() => translateRegex("/(?i:a)/")).toThrow(/inline flags/);
  });

  it("drops eval rules and prunes metas that depend on them, including a negated miss", () => {
    const text = [
      "header __HAS_FROM exists:From",
      "meta HAS_FROM __HAS_FROM",
      "body PRESENT /hello/",
      "body __EV eval:plugin_check()",
      "meta NOT_EV !__EV",
      "meta CHAIN NOT_EV && HAS_FROM",
      "meta BOTH HAS_FROM && PRESENT",
      "header UNSET Subject =~ /missing/ [if-unset: absent]",
      "if plugin(Mail::SpamAssassin::Plugin::DKIM)",
      "body PLUGIN_ONLY /dkim/",
      "endif",
      "if version > 4",
      "body NEW_RULE /newer/",
      "else",
      "body OLD_RULE /older/",
      "endif",
      "body LOOK /(?<=behind)/",
      "",
    ].join("\n");
    const { rules: ported, skips } = compileCfSources([{ name: "fixture.cf", text }]);
    // Topological order: BOTH is emitted once HAS_FROM and PRESENT are ready,
    // ahead of UNSET and NEW_RULE, which do not depend on it.
    expect(ported.map((rule: { name: string }) => rule.name)).toEqual([
      "__HAS_FROM",
      "HAS_FROM",
      "PRESENT",
      "BOTH",
      "UNSET",
      "NEW_RULE",
    ]);
    const unset = ported.find((rule: { name: string }) => rule.name === "UNSET");
    expect(unset.ifUnset).toBe("absent");
    const dropped = new Set(skips.map((skip: { name: string }) => skip.name));
    for (const name of ["__EV", "NOT_EV", "CHAIN", "PLUGIN_ONLY", "OLD_RULE", "LOOK"]) {
      expect(dropped.has(name)).toBe(true);
    }
    expect(skips.some((skip: { name: string; reason: string }) => skip.name === "NOT_EV" && skip.reason === "meta missing dependency")).toBe(true);
    expect(CONDITIONAL_VERSION).toBe("4.000001");
  });

  it("rejects a meta dependency cycle", () => {
    const text = "meta CYCLE_A CYCLE_B\nmeta CYCLE_B CYCLE_A\n";
    expect(() => compileCfSources([{ name: "cycle.cf", text }])).toThrow(/cycle/);
  });

  it("keeps the committed table ordered, compilable, and pinned to r1939780", () => {
    const sources = JSON.parse(fs.readFileSync("vendor/spamassassin/sources.json", "utf8")) as {
      spamassassin: { revision: string; sha256: string };
    };
    expect(sources.spamassassin).toEqual({
      revision: "1939780",
      url: "https://sa-update.spamassassin.org/1939780.tar.gz",
      sha256: "746079a187eefcee1806d077f54f1c0c0f8cb7ac39ce4f8cd94e49ec7a6ca04a",
      conditionalVersion: "4.000001",
    });
    const header = fs.readFileSync("src/spamassassin/generated.ts", "utf8").slice(0, 500);
    expect(header).toContain("r1939780");
    expect(header).toContain("Do not edit by hand");

    expect(rules).toHaveLength(1536);
    expect(rules.filter((rule) => !rule.name.startsWith("__") && !rule.disabled)).toHaveLength(322);
    const seen = new Set<string>();
    for (const rule of rules) {
      if (rule.kind === "meta") {
        for (const dep of rule.deps) expect(seen.has(dep), `${rule.name} missing ${dep}`).toBe(true);
      } else if (!(rule.kind === "header" && rule.exists)) {
        expect(() => new RegExp(rule.source, rule.flags), rule.name).not.toThrow();
      }
      seen.add(rule.name);
    }
    expect(rules.some((rule) => rule.name === "GTUBE" && rule.score === 1000)).toBe(true);
  });
});
