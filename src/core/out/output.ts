import type { ModelConfig } from "../../models/types";

const RESET = "\x1b[0m";
export const dim = (s: string) => `${DIM}${s}${RESET}`;
export const bold = (s: string) => `\x1b[1m${s}${RESET}`;
const green = (s: string) => `\x1b[32m${s}${RESET}`;
const red = (s: string) => `\x1b[31m${s}${RESET}`;
const cyan = (s: string) => `\x1b[36m${s}${RESET}`;
const DIM = "\x1b[2m";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function banner(model: ModelConfig, note: string | null): void {
  console.log();
  const kind = model.api === "responses" ? " · responses-api" : "";
  console.log(bold("◐ halo") + dim(` · ${model.id}${kind} · ${model.baseURL}`));
  if (note) console.log(dim(`  ${note}`));
  console.log(dim("  /help for commands · ctrl-c to exit"));
}

export function success(msg: string): void {
  console.log(`${green("✓")} ${msg}`);
}

export function info(msg: string): void {
  console.log(dim(msg));
}

export function error(msg: string): void {
  console.log(red(`✗ ${msg}`));
}

export function printHelp(presets: string[] = []): void {
  console.log(`
${bold("halo")} — terminal coding agent

${bold("usage")}
  halo                    interactive session
  halo "prompt"           one-shot answer
  halo --help | --version

${bold("commands")}
  /help                   this list
  /model                  show the active model
  /model <id|preset>      switch model for this session (presets: ${presets.join(", ") || "none"})
  /config                 persist current model + baseURL to ~/.halo/config.json
  /clear                  reset conversation history
  /quit                   exit

${bold("tips")}
  end a line with \\ to continue on the next line
  ctrl-c during a reply cancels it; at the prompt it quits
  config: ~/.halo/config.json · key: ~/.halo/.env (or HALO_API_KEY)
`);
}

export interface StreamView {
  /** Reasoning/thinking fragment — rendered dimmed, live. */
  reasoning(text: string): void;
  /** Answer fragment; lazily stops the spinner and prints the label. */
  delta(text: string): void;
  /** Stop the spinner and close the stream block. */
  end(): void;
}

/**
 * Spinner while waiting for the first token, then live streaming.
 * Reasoning streams dimmed under a "✻ thinking" header until the first
 * answer fragment arrives. One view per response.
 */
export function createStreamView(label = "waiting"): StreamView {
  let phase: "idle" | "reasoning" | "answer" = "idle";
  let i = 0;
  const timer = setInterval(() => {
    process.stdout.write(
      `\r\x1b[K${cyan(FRAMES[i % FRAMES.length]!)} ${dim(label)}`,
    );
    i++;
  }, 80);
  const stopSpinner = () => {
    clearInterval(timer);
    process.stdout.write("\r\x1b[K");
  };

  return {
    reasoning(text: string) {
      if (phase === "idle") {
        stopSpinner();
        process.stdout.write(`${dim("✻ thinking")}\n`);
        phase = "reasoning";
      }
      process.stdout.write(dim(text));
    },
    delta(text: string) {
      if (phase === "idle") {
        stopSpinner();
      } else if (phase === "reasoning") {
        process.stdout.write("\n"); // close the thinking block
      }
      if (phase !== "answer") {
        process.stdout.write(cyan("halo ❯ "));
        phase = "answer";
      }
      process.stdout.write(text);
    },
    end() {
      stopSpinner();
      if (phase !== "idle") process.stdout.write("\n\n");
    },
  };
}
