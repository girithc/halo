/** file_read — read a file (with optional line range). */
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import type { Tool } from "../registry";
import { withinRoot } from "./guard";

const DEFAULT_MAX_LINES = 400;

export function readTool(root: string): Tool {
  return {
    name: "file_read",
    description:
      "Read a text file inside the project. Returns numbered lines. " +
      "Large files are paginated: use startLine/endLine for more.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "file path, relative to the project root" },
        startLine: { type: "number", description: "first line to show (1-based)" },
        endLine: { type: "number", description: "last line to show (inclusive)" },
      },
      required: ["path"],
    },
    async execute(args) {
      const rel = String(args.path ?? "").trim();
      if (!rel) return "error: path is required";
      let abs: string;
      try {
        abs = withinRoot(root, rel);
      } catch (err) {
        return `error: ${(err as Error).message}`;
      }
      let content: string;
      try {
        content = await readFile(abs, "utf8");
      } catch (err) {
        return `error: cannot read ${rel}: ${(err as Error).message}`;
      }
      const all = content.split("\n");
      const total = all.length;
      const start = Math.max(1, Number(args.startLine) || 1);
      const end = Math.min(
        total,
        Number(args.endLine) || Math.min(total, start + DEFAULT_MAX_LINES - 1),
      );
      if (start > total) {
        return `error: startLine ${start} is past the end (${total} lines)`;
      }
      const body = all
        .slice(start - 1, end)
        .map((text, i) => `${String(start + i).padStart(4)} | ${text}`);
      const note =
        end < total
          ? `\n… showing ${start}-${end} of ${total} lines — use startLine/endLine to read more`
          : "";
      return `# ${relative(root, abs)}\n${body.join("\n")}${note}`;
    },
  };
}
