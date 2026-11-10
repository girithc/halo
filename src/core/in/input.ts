import * as readline from "node:readline";

/** Sentinel returned when the user hits ctrl-c at a prompt. */
export const CANCEL = "\x03";

export type ParsedInput =
  | { kind: "message"; text: string }
  | { kind: "command"; name: string; args: string };

/** Turn a raw line into either a chat message or a slash command. */
export function parseInput(line: string): ParsedInput {
  const trimmed = line.trim();
  if (trimmed.startsWith("/")) {
    const [rawName = "", ...rest] = trimmed.slice(1).split(/\s+/);
    return { kind: "command", name: rawName.toLowerCase(), args: rest.join(" ") };
  }
  return { kind: "message", text: trimmed };
}

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * Reads lines from stdin. A trailing `\` continues onto the next line.
 * Ctrl-C at a prompt resolves with CANCEL; with nothing pending it calls
 * the fallback (abort the running request, or quit).
 */
export class InputReader {
  #rl: readline.Interface;
  #pending: ((line: string) => void) | null = null;
  #closed = false;
  #fallback: () => void;

  constructor(onInterrupt: () => void) {
    this.#fallback = onInterrupt;
    this.#rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    this.#rl.on("SIGINT", () => {
      if (this.#pending) {
        this.#resolvePending(CANCEL);
      } else {
        this.#fallback();
      }
    });
    this.#rl.on("close", () => {
      this.#closed = true;
      this.#resolvePending(CANCEL);
    });
    // Belt and suspenders for non-TTY stdin, where readline never sees ^C.
    process.on("SIGINT", () => {
      if (this.#pending) {
        this.#resolvePending(CANCEL);
      } else {
        this.#fallback();
      }
    });
  }

  isClosed(): boolean {
    return this.#closed;
  }

  /** Read one logical line (joining `\`-continued lines). */
  readLine(prompt = "you ❯ "): Promise<string> {
    return (async () => {
      let acc = "";
      for (;;) {
        const line = await new Promise<string>((resolve) => {
          if (this.#closed) return resolve(CANCEL);
          this.#pending = resolve;
          this.#rl.question(
            acc ? `${DIM}… ❯ ${RESET}` : prompt,
            (answer: string) => resolve(answer),
          );
        });
        if (line === CANCEL) return CANCEL;
        if (line.endsWith("\\")) {
          acc += `${line.slice(0, -1)}\n`;
          continue;
        }
        return acc + line;
      }
    })();
  }

  close(): void {
    this.#rl.close();
  }

  #resolvePending(line: string): void {
    const resolve = this.#pending;
    this.#pending = null;
    resolve?.(line);
  }
}
