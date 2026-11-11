/** file_edit — exact find/replace inside an existing file. */
import { readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import type { Tool } from "../registry";
import { withinRoot } from "./guard";

export function editTool(root: string): Tool {
  return {
    name: "file_edit",
    description:
      "Replace text in an existing file. Exact match (no regex). If the text " +
      "appears more than once, pass replaceAll=true or the edit is refused.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "file path, relative to the project root" },
        find: { type: "string", description: "exact text to find" },
        replace: { type: "string", description: "replacement text" },
        replaceAll: { type: "boolean", description: "replace every occurrence" },
      },
      required: ["path", "find", "replace"],
    },
    async execute(args) {
      const rel = String(args.path ?? "").trim();
      const find = String(args.find ?? "");
      const replace = String(args.replace ?? "");
      const replaceAll = args.replaceAll === true;
      if (!rel) return "error: path is required";
      if (!find) return "error: find is required";
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
      const count = content.split(find).length - 1;
      if (count === 0) {
        return `error: text not found in ${rel} — read the file first and match exactly`;
      }
      if (count > 1 && !replaceAll) {
        return `error: found ${count} occurrences in ${rel} — pass replaceAll=true, or include more surrounding text`;
      }
      const updated = replaceAll
        ? content.split(find).join(replace)
        : content.replace(find, () => replace);
      try {
        await writeFile(abs, updated, "utf8");
      } catch (err) {
        return `error: cannot write ${rel}: ${(err as Error).message}`;
      }
      return `edited ${relative(root, abs)} (${count} occurrence${count === 1 ? "" : "s"} replaced)`;
    },
  };
}
