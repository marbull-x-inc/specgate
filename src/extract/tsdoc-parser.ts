import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DocBlock,
  DocCodeSpan,
  DocErrorText,
  DocEscapedText,
  DocExcerpt,
  DocFencedCode,
  DocHtmlEndTag,
  DocHtmlStartTag,
  DocInlineTag,
  DocLinkTag,
  type DocNode,
  DocParagraph,
  DocPlainText,
  DocSoftBreak,
  type ParserContext,
  TSDocConfiguration,
  TSDocParser,
  TSDocTagDefinition,
  TSDocTagSyntaxKind,
} from "@microsoft/tsdoc";
import { fileExists } from "../util/paths.ts";

export interface DocTagged {
  text: string;
  /** Line offset inside the comment (0-based). */
  lineOffset: number;
}

export interface DocGuaranteeTag extends DocTagged {
  idToken: string | undefined;
}

export interface DocThrowsTag extends DocGuaranteeTag {
  errorType: string | undefined;
}

export interface DocExample {
  expression: string;
  expected: string;
  lineOffset: number;
}

export interface ParsedDoc {
  summary: string;
  remarks: string | undefined;
  params: Map<string, string>;
  returns: string | undefined;
  guarantees: DocGuaranteeTag[];
  throws: DocThrowsTag[];
  uses: string[];
  modifies: string[];
  invariants: DocTagged[];
  supersedes: string | undefined;
  isEntity: boolean;
  isPort: boolean;
  examples: DocExample[];
  messages: Array<{ text: string; lineOffset: number }>;
}

/** Tag definitions shipped with the package; used when the repo has no tsdoc.json. */
export function builtinTagDefinitions(): TSDocTagDefinition[] {
  const block = (tagName: string, allowMultiple: boolean) =>
    new TSDocTagDefinition({ tagName, syntaxKind: TSDocTagSyntaxKind.BlockTag, allowMultiple });
  const modifier = (tagName: string) => new TSDocTagDefinition({ tagName, syntaxKind: TSDocTagSyntaxKind.ModifierTag });
  return [
    block("@guarantee", true),
    block("@invariant", true),
    block("@uses", true),
    block("@modifies", true),
    block("@supersedes", false),
    modifier("@entity"),
    modifier("@port"),
  ];
}

interface TsdocJson {
  extends?: string[];
  noStandardTags?: boolean;
  tagDefinitions?: Array<{ tagName: string; syntaxKind: "block" | "inline" | "modifier"; allowMultiple?: boolean }>;
  supportForTags?: Record<string, boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTsdocJson(path: string): TsdocJson {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(raw)) throw new Error(`${path}: not an object`);
  const out: TsdocJson = {};
  if (Array.isArray(raw["extends"])) out.extends = raw["extends"].filter((e): e is string => typeof e === "string");
  if (typeof raw["noStandardTags"] === "boolean") out.noStandardTags = raw["noStandardTags"];
  if (Array.isArray(raw["tagDefinitions"])) {
    out.tagDefinitions = [];
    for (const def of raw["tagDefinitions"]) {
      if (!isRecord(def) || typeof def["tagName"] !== "string")
        throw new Error(`${path}: tagDefinitions entries need a tagName`);
      const kind = def["syntaxKind"];
      if (kind !== "block" && kind !== "inline" && kind !== "modifier")
        throw new Error(`${path}: ${def["tagName"]} has an invalid syntaxKind`);
      out.tagDefinitions.push({
        tagName: def["tagName"],
        syntaxKind: kind,
        ...(typeof def["allowMultiple"] === "boolean" ? { allowMultiple: def["allowMultiple"] } : {}),
      });
    }
  }
  if (isRecord(raw["supportForTags"])) {
    out.supportForTags = {};
    for (const [k, v] of Object.entries(raw["supportForTags"])) if (typeof v === "boolean") out.supportForTags[k] = v;
  }
  return out;
}

const SHIPPED_TSDOC_JSON = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "tsdoc.json");

function resolveExtends(entry: string, fromDir: string): string {
  if (entry.startsWith(".") || entry.startsWith("/")) return resolve(fromDir, entry);
  try {
    return createRequire(join(fromDir, "noop.js")).resolve(entry);
  } catch {
    // Inside this package (tests, fixtures) the package is not installed under node_modules.
    if (entry === "specgate/tsdoc.json") return SHIPPED_TSDOC_JSON;
    throw new Error(`Unable to resolve "extends" reference to "${entry}" from ${fromDir}`);
  }
}

/** Depth-first `extends` resolution, later files overriding earlier ones (TSDoc semantics). */
function loadTsdocChain(path: string, seen = new Set<string>()): TsdocJson[] {
  if (seen.has(path)) return [];
  seen.add(path);
  const json = readTsdocJson(path);
  const parents = (json.extends ?? []).flatMap((e) => loadTsdocChain(resolveExtends(e, dirname(path)), seen));
  return [...parents, json];
}

function applyTsdocJson(configuration: TSDocConfiguration, chain: TsdocJson[]): void {
  if (chain.some((c) => c.noStandardTags)) configuration.clear(true);
  const kinds = {
    block: TSDocTagSyntaxKind.BlockTag,
    inline: TSDocTagSyntaxKind.InlineTag,
    modifier: TSDocTagSyntaxKind.ModifierTag,
  } as const;
  for (const json of chain) {
    for (const def of json.tagDefinitions ?? []) {
      if (configuration.tryGetTagDefinition(def.tagName)) continue;
      configuration.addTagDefinition(
        new TSDocTagDefinition({
          tagName: def.tagName,
          syntaxKind: kinds[def.syntaxKind],
          allowMultiple: def.allowMultiple ?? false,
        }),
      );
    }
  }
  for (const json of chain) {
    for (const [tagName, supported] of Object.entries(json.supportForTags ?? {})) {
      const def = configuration.tryGetTagDefinition(tagName);
      if (def) configuration.setSupportForTag(def, supported);
    }
  }
}

/**
 * Builds the parser from `<root>/tsdoc.json` (with `extends` resolved through node resolution,
 * falling back to the shipped file for `specgate/tsdoc.json`) or from the built-in tags.
 * @returns The parser and the messages produced while loading the config, if any. A broken
 *   tsdoc.json still yields a parser with the built-in tags so that `check` can report the error
 *   instead of flagging every tag as undefined.
 */
export function createTsdocParser(root: string): { parser: TSDocParser; configMessages: string[] } {
  const configuration = new TSDocConfiguration();
  const configMessages: string[] = [];
  const configPath = resolve(root, "tsdoc.json");
  if (fileExists(configPath)) {
    try {
      applyTsdocJson(configuration, loadTsdocChain(configPath));
    } catch (error) {
      configMessages.push(error instanceof Error ? error.message : String(error));
      configuration.addTagDefinitions(builtinTagDefinitions());
    }
  } else {
    configuration.addTagDefinitions(builtinTagDefinitions());
  }
  return { parser: new TSDocParser(configuration), configMessages };
}

function firstExcerptPos(node: DocNode): number | undefined {
  if (node instanceof DocExcerpt) {
    const seq = node.content;
    const token = seq.tokens[0];
    return token?.range.pos;
  }
  for (const child of node.getChildNodes()) {
    const pos = firstExcerptPos(child);
    if (pos !== undefined) return pos;
  }
  return undefined;
}

function lineOffsetAt(context: ParserContext, pos: number | undefined): number {
  if (pos === undefined) return 0;
  const text = context.sourceRange.buffer;
  let line = 0;
  for (let i = context.sourceRange.pos; i < pos && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/** Renders a node tree back to plain text. Links to code become the code's text. */
export function renderText(node: DocNode): string {
  if (node instanceof DocPlainText) return node.text;
  if (node instanceof DocSoftBreak) return " ";
  if (node instanceof DocEscapedText) return node.decodedText;
  if (node instanceof DocErrorText) return node.text;
  if (node instanceof DocCodeSpan) return `\`${node.code}\``;
  if (node instanceof DocFencedCode) return `\n${node.code}\n`;
  if (node instanceof DocHtmlStartTag || node instanceof DocHtmlEndTag) return node.emitAsHtml();
  if (node instanceof DocLinkTag) {
    if (node.codeDestination) return node.codeDestination.emitAsTsdoc();
    return node.linkText ?? node.urlDestination ?? "";
  }
  if (node instanceof DocInlineTag) return `{${node.tagName} ${node.tagContent}}`;
  if (node instanceof DocExcerpt) return "";
  const parts = node.getChildNodes().map(renderText);
  const joined = parts.join("");
  return node instanceof DocParagraph ? `${joined}\n` : joined;
}

function blockText(block: DocBlock): string {
  return renderText(block.content).replace(/\s+/g, " ").trim();
}

/** Splits "id rest of text" when the first token looks like an id (no spaces, ASCII, contains no CJK). */
function splitIdToken(text: string): { idToken: string | undefined; text: string } {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return { idToken: undefined, text: text.trim() };
  const token = match[1] ?? "";
  // An id is ASCII letters, digits, dots and dashes. Anything else is the start of prose.
  if (!/^[A-Za-z0-9.\-_]+$/.test(token)) return { idToken: undefined, text: text.trim() };
  return { idToken: token, text: (match[2] ?? "").trim() };
}

function leadingLinkOf(block: DocBlock): { errorType: string | undefined; rest: DocNode[] } {
  const section = block.content;
  const firstParagraph = section.getChildNodes().find((n) => n instanceof DocParagraph);
  if (!(firstParagraph instanceof DocParagraph)) return { errorType: undefined, rest: [] };
  const children = firstParagraph.getChildNodes();
  for (const child of children) {
    if (child instanceof DocPlainText && child.text.trim() === "") continue;
    if (child instanceof DocSoftBreak) continue;
    if (child instanceof DocLinkTag && child.codeDestination) {
      return { errorType: child.codeDestination.emitAsTsdoc(), rest: [] };
    }
    break;
  }
  return { errorType: undefined, rest: [] };
}

function stripLeadingLink(text: string, errorType: string | undefined): string {
  if (!errorType) return text;
  return text.startsWith(errorType) ? text.slice(errorType.length).trim() : text;
}

function parseExamples(block: DocBlock, context: ParserContext): DocExample[] {
  const examples: DocExample[] = [];
  const baseOffset = lineOffsetAt(context, firstExcerptPos(block));
  const visit = (node: DocNode): void => {
    if (node instanceof DocFencedCode) {
      const codeOffset = lineOffsetAt(context, firstExcerptPos(node));
      node.code.split("\n").forEach((line, index) => {
        const ex = parseExampleLine(line, codeOffset + index);
        if (ex) examples.push(ex);
      });
      return;
    }
    if (node instanceof DocParagraph) {
      const text = renderText(node).trim();
      const ex = parseExampleLine(text, lineOffsetAt(context, firstExcerptPos(node)) || baseOffset);
      if (ex) examples.push(ex);
      return;
    }
    for (const child of node.getChildNodes()) visit(child);
  };
  visit(block.content);
  return examples;
}

function parseExampleLine(line: string, lineOffset: number): DocExample | undefined {
  const idx = line.indexOf("// =>");
  if (idx < 0) return undefined;
  const expression = line.slice(0, idx).replace(/^`|`$/g, "").trim();
  const expected = line.slice(idx + 5).trim();
  if (!expression || !expected) return undefined;
  return { expression, expected, lineOffset };
}

function splitIdentifiers(text: string): string[] {
  return text
    .split(/[\s,、]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && /^[A-Za-z_$][\w$]*$/.test(t));
}

/**
 * Parses one doc comment.
 *
 * @param commentText - The full `/** ... *\/` text as it appears in the source.
 * @returns Structured tags. `messages` holds TSDoc syntax problems and unknown tags; the
 *   caller decides their severity.
 */
export function parseDocComment(parser: TSDocParser, commentText: string): ParsedDoc {
  const context = parser.parseString(commentText);
  const comment = context.docComment;
  const params = new Map<string, string>();
  for (const p of comment.params.blocks) params.set(p.parameterName, blockText(p));

  const guarantees: DocGuaranteeTag[] = [];
  const throwsTags: DocThrowsTag[] = [];
  const uses: string[] = [];
  const modifies: string[] = [];
  const invariants: DocTagged[] = [];
  const examples: DocExample[] = [];
  let supersedes: string | undefined;

  for (const block of comment.customBlocks) {
    const tag = block.blockTag.tagNameWithUpperCase;
    const lineOffset = lineOffsetAt(context, firstExcerptPos(block));
    const text = blockText(block);
    switch (tag) {
      case "@GUARANTEE": {
        const { idToken, text: rest } = splitIdToken(text);
        guarantees.push({ idToken, text: rest, lineOffset });
        break;
      }
      case "@USES":
        uses.push(...splitIdentifiers(text));
        break;
      case "@MODIFIES":
        modifies.push(...splitIdentifiers(text));
        break;
      case "@INVARIANT":
        invariants.push({ text, lineOffset });
        break;
      case "@SUPERSEDES":
        supersedes = text;
        break;
      case "@THROWS": {
        const { errorType } = leadingLinkOf(block);
        const stripped = stripLeadingLink(text, errorType);
        const { idToken, text: rest } = splitIdToken(stripped);
        throwsTags.push({ errorType, idToken, text: rest, lineOffset });
        break;
      }
      case "@EXAMPLE":
        examples.push(...parseExamples(block, context));
        break;
      default:
        break;
    }
  }
  // HTML and escaping pedantry is noise for prose such as "end < start" or "// =>"; keep structural problems.
  const IGNORED_MESSAGE_PREFIXES = ["tsdoc-html-", "tsdoc-malformed-html", "tsdoc-escape-"];
  const messages = context.log.messages
    .filter((m) => !IGNORED_MESSAGE_PREFIXES.some((prefix) => m.messageId.startsWith(prefix)))
    .map((m) => ({ text: m.unformattedText, lineOffset: lineOffsetAt(context, m.textRange.pos) }));

  return {
    summary: renderText(comment.summarySection).replace(/\s+/g, " ").trim(),
    remarks: comment.remarksBlock ? blockText(comment.remarksBlock) : undefined,
    params,
    returns: comment.returnsBlock ? blockText(comment.returnsBlock) : undefined,
    guarantees,
    throws: throwsTags,
    uses,
    modifies,
    invariants,
    supersedes,
    isEntity: comment.modifierTagSet.hasTagName("@entity"),
    isPort: comment.modifierTagSet.hasTagName("@port"),
    examples,
    messages,
  };
}

export type { TSDocParser } from "@microsoft/tsdoc";
