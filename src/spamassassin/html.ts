import { Parser } from "htmlparser2";

const BLOCKS = new Set([
  "p",
  "div",
  "table",
  "tr",
  "td",
  "h1",
  "h2",
  "h3",
  "h4",
  "li",
  "ul",
  "ol",
  "blockquote",
  "section",
  "article",
  "hr",
]);

/**
 * Visible text of an HTML part.
 * Script and style contents are omitted. Block tags become blank lines so
 * paragraph splitting still sees the breaks. Entity decoding follows htmlparser2.
 * This is an approximation of SpamAssassin's HTML renderer.
 */
export function renderHtml(html: string): string {
  let text = "";
  let hidden = 0;
  const parser = new Parser(
    {
      onopentag(name) {
        if (name === "script" || name === "style") hidden += 1;
        if (hidden) return;
        if (BLOCKS.has(name)) text += "\n\n";
        else if (name === "br") text += "\n";
      },
      ontext(value) {
        if (!hidden) text += value;
      },
      onclosetag(name) {
        if (name === "script" || name === "style") hidden = Math.max(0, hidden - 1);
        if (!hidden && BLOCKS.has(name)) text += "\n\n";
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return text;
}
