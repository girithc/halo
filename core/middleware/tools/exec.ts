/** Process runner used by shell + git tools. */
import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  output: string;
}

export interface RunOptions {
  cwd: string;
  /** Program to run (used as-is when `shell` is false). */
  command: string;
  /** Argv mode (no shell interpolation). */
  args?: string[];
  /** Run the whole command string through a shell instead. */
  shell?: boolean;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Spawn a command, collect combined output, kill on timeout. Never throws. */
export function runProcess(options: RunOptions): Promise<RunResult> {
  const { cwd, command, args, shell, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  return new Promise((done) => {
    let out = "";
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      done(result);
    };
    let child;
    try {
      child = spawn(command, args ?? [], {
        cwd,
        shell,
        env: process.env,
      });
    } catch (err) {
      finish({ code: -1, output: `error: ${(err as Error).message}` });
      return;
    }
    const collect = (data: Buffer) => {
      out += data.toString();
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: 124, output: `${out}\n[timeout after ${timeoutMs}ms]` });
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ code: -1, output: `error: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ code: code ?? 0, output: out });
    });
  });
}

/** Keep the tail of long output — that's where errors usually live. */
export function truncateOutput(text: string, max = 8000): string {
  return text.length > max ? `…truncated…\n${text.slice(-max)}` : text;
}
