/** Shared guards for file tools: everything stays inside the project root. */
import { resolve, sep } from "node:path";

/** Directories file tools never descend into. */
export const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".halo",
]);

/**
 * Resolve `relativePath` against `root` and refuse anything that
 * escapes it (../ tricks, absolute paths elsewhere).
 */
export function withinRoot(root: string, relativePath: string): string {
  const base = resolve(root);
  const target = resolve(base, relativePath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`path escapes the project root: ${relativePath}`);
  }
  return target;
}
