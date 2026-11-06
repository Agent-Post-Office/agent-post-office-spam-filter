import type { Expr } from "./model.js";

/**
 * SpamAssassin meta operators.
 * `&&` returns the right value when the left is truthy, otherwise 0.
 * `/` and `%` by zero return 0. Missing names are 0, which is only safe
 * because the compiler drops any meta whose dependency was not ported.
 */
export function evaluate(expr: Expr, values: ReadonlyMap<string, number>): number {
  switch (expr.kind) {
    case "number":
      return expr.value;
    case "ref":
      return values.get(expr.name) ?? 0;
    case "unary": {
      const value = evaluate(expr.value, values);
      if (expr.op === "!") return Number(!value);
      if (expr.op === "-") return -value;
      return value;
    }
    case "binary": {
      const left = evaluate(expr.left, values);
      const right = evaluate(expr.right, values);
      switch (expr.op) {
        case "&&":
          return left ? right : 0;
        case "||":
          return left || right;
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          return right ? left / right : 0;
        case "%":
          return right ? left % right : 0;
        case "==":
          return Number(left === right);
        case "!=":
          return Number(left !== right);
        case ">":
          return Number(left > right);
        case "<":
          return Number(left < right);
        case ">=":
          return Number(left >= right);
        case "<=":
          return Number(left <= right);
      }
    }
  }
}
