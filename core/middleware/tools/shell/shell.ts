/** shell_run — run a shell command inside the project. */
import type { Tool } from "../registry";
import { runProcess, truncateOutput } from "../exec";
import { withinRoot } from "../files/guard";

const MAX_OUTPUT = 8000;

export function shellTool(root: string): Tool {
  return {
    name: "shell_run",
    description:
      "Run a shell command inside the project (cwd defaults to the project root). " +
      "Use for builds, tests, git, installs — anything not covered by a dedicated tool. " +
      "Output is truncated to the tail.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "the shell command to run" },
        cwd: { type: "string", description: "optional subdirectory to run in" },
        timeoutMs: { type: "number", description: "max runtime in ms, default 30000" },
      },
      required: ["command"],
    },
    async execute(args) {
      const command = String(args.command ?? "").trim();
      if (!command) return "error: command is required";
      // Refuse the obviously catastrophic, keep everything else flowing.
      if (/^\s*sudo\b/.test(command) || /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+\/(\s|$)/.test(command)) {
        return "error: refusing potentially destructive command — run it yourself in a terminal";
      }
      let cwd = root;
      if (typeof args.cwd === "string" && args.cwd) {
        try {
          cwd = withinRoot(root, args.cwd);
        } catch (err) {
          return `error: ${(err as Error).message}`;
        }
      }
      const timeoutMs = Math.min(120_000, Math.max(1_000, Number(args.timeoutMs) || 30_000));
      const result = await runProcess({ cwd, command, shell: true, timeoutMs });
      const header = `$ ${command}\n[exit ${result.code}${result.code === 124 ? " — timed out" : ""}]`;
      return `${header}\n${truncateOutput(result.output.trim(), MAX_OUTPUT) || "(no output)"}`;
    },
  };
}
