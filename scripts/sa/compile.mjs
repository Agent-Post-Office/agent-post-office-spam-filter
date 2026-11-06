/**
 * Translate a SpamAssassin rules snapshot into src/spamassassin/generated.ts.
 *
 * Build-time only. Uses node:fs and evaluates `if` conditions with Function
 * after they have been reduced to version compares and true/false. Nothing
 * in this file is imported by the published scorer.
 *
 * Unsupported rules are dropped, then meta rules that mention a dropped rule
 * are dropped, repeating until the set stops changing. A meta is never
 * rewritten so that a missing operand becomes 0. `!MISSING` must not become true.
 */
import fs from "node:fs";
import path from "node:path";

const KINDS = ["header", "body", "rawbody", "uri", "full", "meta"];

/** Version substituted into `if version ...` lines. Part of the pinned snapshot's selection. */
export const CONDITIONAL_VERSION = "4.000001";

const POSIX = {
  alpha: "[A-Za-z]",
  alnum: "[A-Za-z0-9]",
  digit: "[0-9]",
  lower: "[a-z]",
  upper: "[A-Z]",
  xdigit: "[0-9a-fA-F]",
  space: "[\\t\\n\\r\\f\\v ]",
  blank: "[\\t ]",
  word: "[A-Za-z0-9_]",
  punct: "[!-/:-@\\[-`{-~]",
  ascii: "[\\x00-\\x7f]",
  cntrl: "[\\x00-\\x1f\\x7f]",
  print: "[ -~]",
  graph: "[!-~]",
};

function clean(line) {
  return line.replace(/(?<!\\)#.*$/, "").trim();
}

function condition(source) {
  const reduced = source
    .replace(/\b(?:can|plugin)\(([^)]+)\)/g, (_, name) =>
      String(name.startsWith("Mail::SpamAssassin::Conf::") && !name.endsWith("compat_welcomelist_blocklist")),
    )
    .replace(/\bversion\b/g, CONDITIONAL_VERSION);
  if (!/^[\d\s.()!<>=&|truefals]+$/.test(reduced)) throw new Error(`Unknown condition ${source}`);
  return Boolean(Function(`return (${reduced})`)());
}

function unextended(source) {
  let out = "";
  let inClass = false;
  let escaped = false;
  for (const char of source) {
    if (escaped) {
      out += `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "[") inClass = true;
    if (char === "]") inClass = false;
    if (!inClass && /\s/.test(char)) continue;
    if (!inClass && char === "#") break;
    out += char;
  }
  return out;
}

/** Translate one Perl regexp literal (`/pat/i`, `m{pat}x`) into a JS source and flags. */
export function translateRegex(value) {
  const wrapped = /^(?:m)?([^\w\s\\])(.*)$/.exec(value);
  if (!wrapped) throw new Error("regex delimiter");
  const close = wrapped[1] === "{" ? "}" : wrapped[1];
  const end = wrapped[2].lastIndexOf(close);
  if (end < 0) throw new Error("regex closing delimiter");
  let source = wrapped[2].slice(0, end);
  const tail = wrapped[2].slice(end + 1);
  const modifierMatch = /^([a-z]*)(.*)$/i.exec(tail);
  let mods = modifierMatch[1];
  const extra = modifierMatch[2].trim();
  const leading = /^\(\?([imsx]+)\)/.exec(source);
  if (leading) {
    mods += leading[1];
    source = source.slice(leading[0].length);
  }
  if (/\(\?[imsx-]+[:)]/.test(source)) throw new Error("scoped or interior inline flags");
  if (/\(\?<([=!])/.test(source)) throw new Error("lookbehind conservative skip");
  if (/(?:[+*?]|\{\d+(?:,\d*)?\})\+/.test(source)) throw new Error("possessive quantifier");
  if (/\(\?>/.test(source)) throw new Error("atomic group");
  if (/\\[pP]\{|\\[gkKRCX]|\(\?\{|\(\?\(|\(\?R|%\{/.test(source)) {
    throw new Error("Perl property recursion code backref or template");
  }
  if (/\\x\{/.test(source)) throw new Error("Perl extended codepoint");
  source = source.replace(/\\Q([\s\S]*?)\\E/g, (_, quoted) => quoted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (source.includes("\\Q") || source.includes("\\E")) throw new Error("unpaired quoting");
  if (mods.includes("x")) source = unextended(source);
  source = source.replace(/\[\[:(alpha|alnum|digit|lower|upper|xdigit|space|blank|word|punct|ascii|cntrl|print|graph):\]\]/g, (_, name) => POSIX[name]);
  if (/\[:\w+:\]/.test(source)) throw new Error("nested POSIX class");
  source = source
    .replace(/\\A/g, "(?<![\\s\\S])")
    .replace(/\\z/g, "(?![\\s\\S])")
    .replace(/\\Z/g, "(?=\\n?(?![\\s\\S]))")
    .replace(/\\h/g, "[\\t ]")
    .replace(/\\H/g, "[^\\t ]");
  // Perl \v is every vertical whitespace character. JS \v is only the vertical tab.
  source = source.replace(/\\v/g, "[\\n\\r\\f\\x0b]").replace(/\\V/g, "[^\\n\\r\\f\\x0b]");
  if (/[^imsx]/.test(mods)) throw new Error(`unsupported regex modifier ${mods}`);
  const flags = [...new Set(mods.replace(/x/g, ""))].join("");
  // Reject translations the JS engine will not compile. The rule is dropped, not shipped.
  new RegExp(source, flags);
  return { source, flags, extra };
}

function tokenizeMeta(expr) {
  const tokens = [];
  let rest = expr;
  while (rest.trim()) {
    rest = rest.trimStart();
    const match = /^(\d+(?:\.\d+)?|[A-Za-z_]\w*|&&|\|\||==|!=|>=|<=|[()+*/%<>!+-])/.exec(rest);
    if (!match) throw new Error(`meta syntax ${rest.slice(0, 30)}`);
    tokens.push(match[1]);
    rest = rest.slice(match[0].length);
  }
  return tokens;
}

const PRECEDENCE = { "||": 1, "&&": 2, "==": 3, "!=": 3, ">": 4, "<": 4, ">=": 4, "<=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6 };

/** Parse a meta expression. `names` is every declared rule, used by `rules_matching`. */
export function compileMeta(expr, names) {
  const expanded = expr.replace(/rules_matching\(([^)]+)\)/g, (_, glob) => {
    const pattern = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
    return `(${[...names].filter((name) => pattern.test(name)).join(" + ")})`;
  });
  const tokens = tokenizeMeta(expanded);
  let pos = 0;
  const deps = new Set();
  function parse(min = 0) {
    const token = tokens[pos++];
    let left;
    if (token === "!" || token === "-" || token === "+") left = { kind: "unary", op: token, value: parse(7) };
    else if (token === "(") {
      left = parse();
      if (tokens[pos++] !== ")") throw new Error("meta parentheses");
    } else if (/^\d/.test(token ?? "")) left = { kind: "number", value: Number(token) };
    else if (/^[A-Za-z_]\w*$/.test(token ?? "")) {
      deps.add(token);
      left = { kind: "ref", name: token };
    } else throw new Error("meta atom");
    while (PRECEDENCE[tokens[pos]] >= min) {
      const op = tokens[pos++];
      left = { kind: "binary", op, left, right: parse(PRECEDENCE[op] + 1) };
    }
    return left;
  }
  const ast = parse();
  if (pos !== tokens.length) throw new Error("meta trailing syntax");
  return { ast, deps: [...deps] };
}

function parseSources(files) {
  const all = new Map();
  const selected = new Map();
  const scores = new Map();
  const flags = new Map();
  const skips = [];
  const declarations = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
  const extraDirectives = { mimeheader: 0, uridnssub: 0, urirhssub: 0, askdns: 0 };
  let evalDeclarationCount = 0;
  const conditions = new Set();

  for (const file of files) {
    const stack = [];
    let active = true;
    const lines = file.text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = clean(lines[index]);
      if (!line) continue;
      const token = line.split(/\s+/)[0];
      if (token in extraDirectives) extraDirectives[token] += 1;
      if (/^(?:header|body|rawbody|uri|full)\s+\w+\s+.*\beval:/.test(line)) evalDeclarationCount += 1;
      if (line.startsWith("ifplugin ")) {
        stack.push({ parent: active, result: false });
        active = false;
        continue;
      }
      if (line.startsWith("if ")) {
        const result = condition(line.slice(3));
        conditions.add(line.slice(3));
        stack.push({ parent: active, result });
        active = active && result;
        continue;
      }
      if (line === "else") {
        const top = stack.at(-1);
        if (!top) throw new Error("bad else");
        active = top.parent && !top.result;
        continue;
      }
      if (line === "endif") {
        const top = stack.pop();
        if (!top) throw new Error("bad endif");
        active = top.parent;
        continue;
      }
      const declared = /^(header|body|rawbody|uri|full|meta)\s+(\w+)\s+(.+)$/.exec(line);
      if (declared) {
        const [, kind, name, value] = declared;
        declarations[kind] += 1;
        const record = { kind, name, value, file: file.name, line: index + 1 };
        all.set(name, record);
        if (active) selected.set(name, record);
        continue;
      }
      if (!active) continue;
      const score = /^score\s+(\w+)\s+(.+)$/.exec(line);
      if (score) {
        const values = score[2].trim().split(/\s+/);
        const first = values[0];
        if (/^\([\d.+-]+\)$/.test(first)) scores.set(score[1], (scores.get(score[1]) ?? 1) + Number(first.slice(1, -1)));
        else if (Number.isFinite(Number(first))) scores.set(score[1], Number(first));
      }
      const tflags = /^tflags\s+(\w+)\s+(.+)$/.exec(line);
      if (tflags) flags.set(tflags[1], tflags[2].split(/\s+/));
    }
    if (stack.length) throw new Error(`unclosed conditions ${file.name}`);
  }

  return { all, selected, scores, flags, skips, declarations, extraDirectives, evalDeclarationCount, conditions };
}

function portRules(state) {
  const { all, selected, scores, flags, skips } = state;
  for (const record of all.values()) {
    if (!selected.has(record.name)) skips.push({ ...record, reason: "conditional plugin or capability disabled" });
  }
  const portable = new Map();
  for (const record of selected.values()) {
    try {
      const tflags = flags.get(record.name) ?? [];
      if (tflags.some((flag) => flag === "net" || flag === "learn") || (tflags.includes("userconf") && record.name !== "GTUBE")) {
        throw new Error("network learning or user configuration flag");
      }
      if (/\beval:/.test(record.value)) throw new Error("eval plugin");
      const score = record.name.startsWith("__") ? 0 : (scores.get(record.name) ?? (record.name.startsWith("T_") ? 0.01 : 1));
      const base = {
        kind: record.kind,
        name: record.name,
        score,
        disabled: scores.get(record.name) === 0,
        multiple: tflags.includes("multiple"),
        maxhits: Number(tflags.find((flag) => flag.startsWith("maxhits="))?.slice(8) ?? 100),
        nosubject: tflags.includes("nosubject"),
        file: record.file,
        line: record.line,
      };
      let out;
      if (record.kind === "meta") out = { ...base, ...compileMeta(record.value, all.keys()) };
      else if (record.kind === "header") {
        const exists = /^exists:(\S+)$/.exec(record.value);
        if (exists) out = { ...base, header: exists[1], exists: true, negate: false };
        else {
          const match = /^(\S+)\s+(=~|!~)\s+(.+)$/.exec(record.value);
          if (!match) throw new Error("header syntax");
          const regex = translateRegex(match[3]);
          const unset = /^\[if-unset:\s*(.*?)\]$/.exec(regex.extra);
          if (regex.extra && !unset) throw new Error("header suffix");
          out = {
            ...base,
            header: match[1],
            exists: false,
            negate: match[2] === "!~",
            source: regex.source,
            flags: regex.flags,
            ...(unset ? { ifUnset: unset[1] } : {}),
          };
        }
        if (/X-Spam-Relays-|^ALL-|^EnvelopeFrom$/i.test(out.header)) {
          throw new Error("requires trust path or SMTP envelope pseudo-header");
        }
      } else {
        const regex = translateRegex(record.value);
        if (regex.extra) throw new Error("regex suffix");
        out = { ...base, source: regex.source, flags: regex.flags };
      }
      portable.set(record.name, out);
    } catch (error) {
      skips.push({ ...record, reason: error.message });
    }
  }

  let removed = true;
  while (removed) {
    removed = false;
    for (const [name, rule] of portable) {
      if (rule.kind !== "meta") continue;
      const missing = rule.deps.filter((dep) => !portable.has(dep));
      if (!missing.length) continue;
      portable.delete(name);
      skips.push({ ...selected.get(name), reason: "meta missing dependency", missing });
      removed = true;
    }
  }

  const sorted = [];
  const visited = new Set();
  const visiting = new Set();
  function visit(name) {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`meta dependency cycle ${name}`);
    visiting.add(name);
    const rule = portable.get(name);
    if (rule.kind === "meta") rule.deps.forEach(visit);
    visiting.delete(name);
    visited.add(name);
    sorted.push(rule);
  }
  portable.forEach((_, name) => visit(name));

  const counts = Object.fromEntries(KINDS.map((kind) => [kind, {
    declarations: state.declarations[kind],
    selected: [...selected.values()].filter((rule) => rule.kind === kind).length,
    ported: sorted.filter((rule) => rule.kind === kind).length,
  }]));
  const reasons = {};
  for (const skip of skips) reasons[skip.reason] = (reasons[skip.reason] ?? 0) + 1;
  const summary = {
    extraDirectives: state.extraDirectives,
    evalDeclarationCount: state.evalDeclarationCount,
    declarations: state.declarations,
    totalDeclarations: Object.values(state.declarations).reduce((sum, count) => sum + count, 0),
    totalUnique: all.size,
    totalSelected: selected.size,
    totalPorted: sorted.length,
    scored: sorted.filter((rule) => !rule.name.startsWith("__") && !rule.disabled).length,
    disabled: sorted.filter((rule) => rule.disabled).length,
    counts,
    skipReasons: reasons,
    conditionalVersion: CONDITIONAL_VERSION,
  };
  return { rules: sorted, skips, summary };
}

/** Compile rule text already loaded in memory. `files` is `{ name, text }[]` in snapshot order. */
export function compileCfSources(files) {
  return portRules(parseSources(files));
}

/** Compile every `*.cf` file in a directory. Names are sorted so the snapshot is stable. */
export function compileCfDirectory(dir) {
  const names = fs.readdirSync(dir).filter((name) => name.endsWith(".cf")).sort();
  const files = names.map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), "utf8") }));
  return compileCfSources(files);
}

export function renderGenerated(rules) {
  return `${GENERATED_HEADER}import type { Rule } from "./model.js";\nexport const rules: Rule[] = ${JSON.stringify(rules)};\n`;
}

export const GENERATED_HEADER = `// Generated by \`npm run sa:verify\` from SpamAssassin update channel r1939780.
// Modified rule representations translated from Perl to JavaScript.
// Not the SpamAssassin engine. Do not edit by hand.
// See NOTICE and vendor/spamassassin/sources.json.
`;

/** Regex checks from regression_tests.cf. Meta and exists rules are counted as skipped. */
export function runUpstreamTests(cfText, rules) {
  let pass = 0;
  let skip = 0;
  const fail = [];
  for (const line of cfText.split("\n")) {
    const match = /^test\s+(\w+)\s+(ok|fail)\s+(.*)$/.exec(line);
    if (!match) continue;
    const rule = rules.find((item) => item.name === match[1]);
    if (!rule || rule.kind === "meta" || rule.exists) {
      skip += 1;
      continue;
    }
    let matched = new RegExp(rule.source, rule.flags).test(match[3]);
    if (rule.negate) matched = !matched;
    if (matched === (match[2] === "ok")) pass += 1;
    else fail.push({ name: rule.name, expected: match[2] });
  }
  return { pass, skip, fail };
}
