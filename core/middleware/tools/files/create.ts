/** file_create — create a new file (never overwrites). */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import type { Tool } from "../registry";
import { withinRoot } from "./guard";

export function createTool(root: string): Tool {
  return {
    name: "file_create",
    description:
      "Create a new file with content (parent directories are created as needed). " +
      "Refuses to overwrite an existing file — use file_edit to change one.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "new file path, relative to the project root" },
        content: { type: "string", description: "full file content" },
      },
      required: ["path", "content"],
    },
    async execute(args) {
      const rel = String(args.path ?? "").trim();
      const content = String(args.content ?? "");
      if (!rel) return "error: path is required";
      let abs: string;
      try {
        abs = withinRoot(root, rel);
      } catch (err) {
        return `error: ${(err as Error).message}`;
      }
      try {
        await mkdir(dirname(abs), { recursive: true });
        const { open } = await import("node:fs/promises");
        // wx flag: fail instead of overwriting an existing file
        const handle = await open(abs, "wx");
        await handle.writeFile(content, "utf8");
        await handle.close();
        return `created ${relative(root, abs)} (${content.length} bytes)`;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          return `error: ${rel} already exists — use file_edit to change it`;
        }
        return `error: cannot create ${rel}: ${(err as Error).message}`;
      }
    },
  };
}
