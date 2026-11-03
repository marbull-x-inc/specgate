import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import type { Config } from "../config/schema.ts";

/**
 * Makes generated code look like the project's own: quote style and title length.
 *
 * @remarks
 * Generation works in double quotes throughout (its own import parsing relies on it); the
 * conversion to single quotes is a last step on the generated text only, so a user's existing
 * code is never re-quoted.
 */
export type QuoteStyle = "double" | "single";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Removes `//` and `/* *\/` comments outside strings, for reading `biome.jsonc`. */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += ch;
  }
  return out;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

/**
 * The quote style to generate. `tests.quote` wins unless it is `"auto"`; then the first of
 * Biome's `javascript.formatter.quoteStyle` (`biome.json` / `biome.jsonc`) and Prettier's
 * `singleQuote` (`.prettierrc`, `.prettierrc.json`, `package.json#prettier`) found in `root`.
 * Formatter configs in other formats (YAML, JS) are not read; double is the fallback.
 */
export function resolveQuote(config: Config): QuoteStyle {
  if (config.tests.quote !== "auto") return config.tests.quote;
  for (const name of ["biome.json", "biome.jsonc"]) {
    const path = join(config.root, name);
    if (!existsSync(path)) continue;
    const json = readJson(path);
    const js = isRecord(json) ? json["javascript"] : undefined;
    const formatter = isRecord(js) ? js["formatter"] : undefined;
    const style = isRecord(formatter) ? formatter["quoteStyle"] : undefined;
    if (style === "single" || style === "double") return style;
  }
  for (const name of [".prettierrc", ".prettierrc.json"]) {
    const path = join(config.root, name);
    if (!existsSync(path)) continue;
    const json = readJson(path);
    if (isRecord(json) && typeof json["singleQuote"] === "boolean") return json["singleQuote"] ? "single" : "double";
  }
  const pkg = readJson(join(config.root, "package.json"));
  const prettier = isRecord(pkg) ? pkg["prettier"] : undefined;
  if (isRecord(prettier) && typeof prettier["singleQuote"] === "boolean")
    return prettier["singleQuote"] ? "single" : "double";
  return "double";
}

function singleQuoted(value: string): string {
  // JSON escaping for control characters and backslashes, then swap the quote that needs escaping.
  const json = JSON.stringify(value);
  const body = json.slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'");
  return `'${body}'`;
}

/**
 * Rewrites the double-quoted string literals of generated `code` with single quotes (a literal
 * containing `'` is left double-quoted, as formatters do). Template literals, comments and
 * regular expressions are untouched: only tokens the TypeScript scanner reports as string
 * literals change.
 */
export function applyQuote(code: string, style: QuoteStyle): string {
  if (style === "double") return code;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, code);
  let out = "";
  let last = 0;
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.StringLiteral) continue;
    const start = scanner.getTokenStart();
    const end = scanner.getTokenEnd();
    if (code[start] !== '"') continue;
    const value = scanner.getTokenValue();
    if (value.includes("'")) continue;
    out += code.slice(last, start) + singleQuoted(value);
    last = end;
  }
  return out + code.slice(last);
}

/**
 * A test title within `tests.titleLength`: the prefix and key whole, the statement cut at the
 * last space before the limit (or at the limit, for text without spaces) with "…".
 *
 * @returns The title, and the full statement when it was cut (for a comment above the test).
 */
export function shortTitle(head: string, statement: string, limit: number): { title: string; full?: string } {
  const whole = `${head} ${statement}`.trim();
  if (limit <= 0 || whole.length <= limit || statement === "") return { title: whole };
  const room = limit - head.length - 2; // a space and the ellipsis
  if (room < 8) return { title: head, full: statement };
  const cut = statement.slice(0, room);
  const space = cut.lastIndexOf(" ");
  const shortened = (space >= room / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:、。]+$/u, "");
  return { title: `${head} ${shortened}…`, full: statement };
}
