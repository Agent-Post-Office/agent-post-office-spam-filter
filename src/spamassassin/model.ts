/**
 * Shape of one translated SpamAssassin rule.
 * `src/spamassassin/generated.ts` is a snapshot of these objects.
 */

export type Expr =
  | { kind: "number"; value: number }
  | { kind: "ref"; name: string }
  | { kind: "unary"; op: "!" | "+" | "-"; value: Expr }
  | {
      kind: "binary";
      op: "&&" | "||" | "==" | "!=" | ">" | "<" | ">=" | "<=" | "+" | "-" | "*" | "/" | "%";
      left: Expr;
      right: Expr;
    };

interface RuleBase {
  name: string;
  score: number;
  disabled: boolean;
  multiple: boolean;
  maxhits: number;
  nosubject: boolean;
  file: string;
  line: number;
}

export type MetaRule = RuleBase & { kind: "meta"; ast: Expr; deps: string[] };

export type HeaderRule = RuleBase & {
  kind: "header";
  header: string;
  exists: boolean;
  negate: boolean;
  source?: string;
  flags?: string;
  ifUnset?: string;
};

export type TextRule = RuleBase & {
  kind: "body" | "rawbody" | "full" | "uri";
  source: string;
  flags: string;
};

export type Rule = MetaRule | HeaderRule | TextRule;
