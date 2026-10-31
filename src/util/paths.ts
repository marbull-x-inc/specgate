import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { glob } from "tinyglobby";

export function toPosix(path: string): string {
  return path.split(sep).join("/");
}

export function relativeTo(root: string, file: string): string {
  return toPosix(relative(root, file));
}

export function absoluteFrom(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

export async function expandGlobs(root: string, include: string[], exclude: string[] = []): Promise<string[]> {
  const files = await glob(include, {
    cwd: root,
    ignore: [...exclude, "**/node_modules/**"],
    absolute: true,
    onlyFiles: true,
  });
  return files.map((f) => resolve(f)).sort();
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}
