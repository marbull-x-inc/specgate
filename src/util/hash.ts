import { createHash } from "node:crypto";

/** Collapses whitespace so that reflowing a comment does not count as a change of meaning. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function textHash(text: string): string {
  return sha256(normalizeText(text)).slice(0, 16);
}
