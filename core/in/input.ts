import * as readline from "node:readline";

/** Sentinel returned when the user hits ctrl-c at a prompt or stdin ends. */
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
 * Reads lines from stdin.
 *
 * Lines are queued as they arrive, so input is never lost even when it
 * arrives between prompts (piped scripts, fast typists). A trailing `\`
 * continues onto the next line. Ctrl-C at a prompt resolves with CANCEL;
 * with nothing pending it calls the fallback (abort the running request,
 * or quit). Queue is drained before EOF is honoured.
 */
export class InputReader {
  #rl: readline.Interface;
  #queue: string[] = [];
  #waiter: ((line: string) => void) | null = null;
  #closed = false;
  #fallback: () => void;

  constructor(onInterrupt: () => void) {
    this.#fallback = onInterrupt;
    this.#rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false, // TTY echo is handled by the terminal itself
    });
    this.#rl.on("line", (line: string) => {
      if (this.#waiter) {
        const waiter = this.#waiter;
        this.#waiter = null;
        waiter(line);
      } else {
        this.#queue.push(line);
      }
    });
    this.#rl.on("SIGINT", () => this.#onInterrupt());
    this.#rl.on("close", () => {
      this.#closed = true;
      this.#resolveWaiter(CANCEL);
    });
    // Belt and suspenders for non-TTY stdin, where readline never sees ^C.
    process.on("SIGINT", () => this.#onInterrupt());
  }

  isClosed(): boolean {
    return this.#closed;
  }

  /** Read one logical line (joining `\`-continued lines). */
  async readLine(prompt = "you ❯ "): Promise<string> {
    let acc = "";
    for (;;) {
      if (this.#queue.length === 0 && this.#closed) return CANCEL;
      process.stdout.write(acc ? `${DIM}… ❯ ${RESET}` : prompt);
      const line =
        this.#queue.length > 0
          ? this.#queue.shift()!
          : await new Promise<string>((resolve) => {
              this.#waiter = resolve;
            });
      if (line === CANCEL) return CANCEL;
      if (line.endsWith("\\")) {
        acc += `${line.slice(0, -1)}\n`;
        continue;
      }
      return acc + line;
    }
  }

  close(): void {
    this.#rl.close();
  }

  #onInterrupt(): void {
    if (this.#waiter) {
      this.#resolveWaiter(CANCEL);
    } else {
      this.#fallback();
    }
  }

  #resolveWaiter(line: string): void {
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.(line);
  }
}
