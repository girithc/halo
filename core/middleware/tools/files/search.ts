/** file_search — find files by name or content. */
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import type { Tool } from "../registry";
import { IGNORED_DIRS, withinRoot } from "./guard";

/** Extensions never treated as searchable text. */
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz",
  ".tar", ".mp4", ".mov", ".woff", ".woff2", ".ttf", ".lock",
]);

const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES_SCANNED = 5000;

export function searchTool(root: string): Tool {
  return {
    name: "file_search",
    description:
      "Search the project. Matches file CONTENT (case-insensitive) and file NAMES. " +
      "A query wrapped in /slashes/ is treated as a case-insensitive regex. " +
      "Returns 'path:line: text' matches.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "text to search for" },
        path: { type: "string", description: "optional subdirectory to search within" },
        nameOnly: { type: "boolean", description: "match file names only, not contents" },
        maxResults: { type: "number", description: "max matches, default 40" },
      },
      required: ["query"],
    },
    async execute(args) {
      const query = String(args.query ?? "").trim();
      if (!query) return "error: query is required";
      const needle = query.toLowerCase();
      const nameOnly = args.nameOnly === true;
      const max = Math.min(200, Math.max(1, Number(args.maxResults) || 40));
      const sub = typeof args.path === "string" && args.path ? args.path : ".";
      let base: string;
      try {
        base = withinRoot(root, sub);
      } catch (err) {
        return `error: ${(err as Error).message}`;
      }
      let regex: RegExp | null = null;
      if (query.length > 2 && query.startsWith("/") && query.endsWith("/")) {
        try {
          regex = new RegExp(query.slice(1, -1), "i");
        } catch {
          return "error: invalid regex";
        }
      }

      const matches: string[] = [];
      let scanned = 0;
      const walk = async (dir: string): Promise<void> => {
        if (matches.length >= max || scanned >= MAX_FILES_SCANNED) return;
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (matches.length >= max || scanned >= MAX_FILES_SCANNED) return;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
              await walk(full);
            }
            continue;
          }
          if (!entry.isFile() || BINARY_EXT.has(extname(entry.name))) continue;
          scanned++;
          const rel = relative(root, full);
          if (nameOnly) {
            if (rel.toLowerCase().includes(needle)) {
              matches.push(`${rel} (name match)`);
            }
            continue;
          }
          let content: string;
          try {
            const info = await stat(full);
            if (info.size > MAX_FILE_BYTES) continue;
            content = await readFile(full, "utf8");
          } catch {
            continue;
          }
          if (content.includes("\0")) continue; // binary — skip
          content.split("\n").forEach((lineText, idx) => {
            if (matches.length >= max) return;
            const hit = regex
              ? regex.test(lineText)
              : lineText.toLowerCase().includes(needle);
            if (hit) {
              matches.push(`${rel}:${idx + 1}: ${lineText.trim().slice(0, 160)}`);
            }
          });
        }
      };
      await walk(base);
      return matches.length
        ? matches.join("\n")
        : `no matches for "${query}"`;
    },
  };
}
