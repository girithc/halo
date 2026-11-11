/** Git helper tools — read-only views + guarded commits. */
import type { Tool } from "../registry";
import { runProcess, truncateOutput } from "../exec";
import { withinRoot } from "../files/guard";

async function runGit(root: string, args: string[]): Promise<{ code: number; output: string }> {
  const result = await runProcess({ cwd: root, command: "git", args, timeoutMs: 15_000 });
  return { code: result.code, output: truncateOutput(result.output.trim()) };
}

export function gitTools(root: string): Tool[] {
  return [
    {
      name: "git_status",
      description: "Show branch + working tree status (short format).",
      parameters: { type: "object", properties: {} },
      async execute() {
        const { code, output } = await runGit(root, ["status", "--short", "--branch"]);
        return code === 0
          ? output || "clean working tree"
          : `error: ${output || "git failed"}`;
      },
    },
    {
      name: "git_diff",
      description: "Show the diff of changes (unstaged by default; staged=true for the index).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "limit to one file/dir" },
          staged: { type: "boolean", description: "diff the staged index instead" },
        },
      },
      async execute(args) {
        const gitArgs = ["diff"];
        if (args.staged === true) gitArgs.push("--staged");
        gitArgs.push("--");
        if (typeof args.path === "string" && args.path) {
          try {
            withinRoot(root, args.path); // refuse escapes before git sees it
          } catch (err) {
            return `error: ${(err as Error).message}`;
          }
          gitArgs.push(args.path);
        }
        const { code, output } = await runGit(root, gitArgs);
        return code === 0 ? output || "(no changes)" : `error: ${output}`;
      },
    },
    {
      name: "git_log",
      description: "Show recent commit history (one line per commit).",
      parameters: {
        type: "object",
        properties: { count: { type: "number", description: "how many commits, default 10" } },
      },
      async execute(args) {
        const count = Math.min(50, Math.max(1, Number(args.count) || 10));
        const { code, output } = await runGit(root, ["log", "--oneline", `-${count}`]);
        return code === 0 ? output : `error: ${output}`;
      },
    },
    {
      name: "git_commit",
      description:
        "Commit the current work. addAll=true stages every change first; otherwise " +
        "only already-staged changes are committed. Never pushes.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "commit message" },
          addAll: { type: "boolean", description: "stage all changes before committing" },
        },
        required: ["message"],
      },
      async execute(args) {
        const message = String(args.message ?? "").trim();
        if (!message) return "error: commit message is required";
        if (args.addAll === true) {
          const add = await runGit(root, ["add", "-A"]);
          if (add.code !== 0) return `error: git add failed: ${add.output}`;
        }
        const { code, output } = await runGit(root, ["commit", "-m", message]);
        return code === 0
          ? output.split("\n")[0] || "committed"
          : `error: ${output || "commit failed"}`;
      },
    },
  ];
}
