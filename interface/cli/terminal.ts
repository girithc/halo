/**
 * Terminal painting — everything that renders text, no React.
 *
 * Two consumers share this module:
 *   - the TUI (App.tsx): renderChat() turns chat data into styled rows
 *   - plain-stdout paths (one-shot halo "prompt", onboarding wizard):
 *     banner / printHelp / createStreamView / success-info-error
 */
import type { SessionEntry } from "../../core/agent";
import type { ModelConfig } from "../../models/types";

// ---- ANSI colors -----------------------------------------------------------

const RESET = "\x1b[0m";
export const dim = (s: string) => `${DIM}${s}${RESET}`;
export const bold = (s: string) => `\x1b[1m${s}${RESET}`;
/** Readable gray — dimmer than the answer, but legible on dark terminals. */
export const gray = (s: string) => `\x1b[90m${s}${RESET}`;
const yellow = (s: string) => `\x1b[33m${s}${RESET}`;
const green = (s: string) => `\x1b[32m${s}${RESET}`;
const red = (s: string) => `\x1b[31m${s}${RESET}`;
const cyan = (s: string) => `\x1b[36m${s}${RESET}`;
const DIM = "\x1b[2m";

export const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ---- chat lines (TUI) --------------------------------------------------------

/** One renderable row (prefix + styled text); colors are ink color names. */
export interface Line {
  prefix?: string;
  prefixColor?: string;
  text: string;
  color?: string;
  bgColor?: string;
  dim?: boolean;
  italic?: boolean;
}

/** Renders the chat data as lines (prefixes, colors, spacing). */
export function renderChat(
  messages: readonly SessionEntry[],
  opts: {
    width: number;
    busy: boolean;
    frame: string;
    elapsed: number;
    modelId: string;
  },
): Line[] {
  const lines: Line[] = [];
  for (const m of messages) {
    // Blank line before conversation turns only — tool calls, results and
    // thinking lines hug whatever came above them, no wasted rows.
    const gap = m.role === "info" || m.role === "thought" ? 0 : 1;
    for (let i = 0; i < gap; i++) lines.push({ text: "" });
    switch (m.role) {
      case "user":
        pushWrapped(lines, "you ❯ ", "magentaBright", m.text, {}, opts.width);
        break;
      case "assistant":
        if (m.text) pushAssistantBody(lines, m.text, opts.width);
        break;
      case "info":
        pushWrapped(lines, "", undefined, `· ${m.text}`, { dim: true }, opts.width);
        break;
      case "thought":
        pushWrapped(
          lines,
          "",
          undefined,
          `✻ thought for ${m.seconds ?? 1}s`,
          { dim: true, italic: true },
          opts.width,
        );
        break;
    }
  }
  if (opts.busy) {
    const thinking = messages[messages.length - 1]?.role === "assistant";
    lines.push({
      prefix: `${opts.frame} `,
      prefixColor: "cyan",
      text: thinking ? "✻ thinking" : `waiting · ${opts.modelId} · ${opts.elapsed}s`,
      dim: true,
    });
  }
  return lines;
}

/** Greedy word wrap that PRESERVES each line's leading indentation
 * (code blocks keep their nesting) and hard-splits overlong words. */
function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    const lead = (paragraph.match(/^ */) ?? [""])[0] ?? "";
    const body = paragraph.slice(lead.length);
    if (body === "") {
      out.push("");
      continue;
    }
    const lineWidth = Math.max(10, width - lead.length);
    let line = "";
    for (const word of body.split(" ")) {
      let w = word;
      if (!line) {
        while (w.length > lineWidth) {
          out.push(lead + w.slice(0, lineWidth));
          w = w.slice(lineWidth);
        }
        line = w;
      } else if ((line + " " + w).length <= lineWidth) {
        line += " " + w;
      } else {
        out.push(lead + line);
        while (w.length > lineWidth) {
          out.push(lead + w.slice(0, lineWidth));
          w = w.slice(lineWidth);
        }
        line = w;
      }
    }
    out.push(lead + line);
  }
  return out;
}

/**
 * Assistant body renderer: prose carries the halo ❯ prefix (first line
 * only). ``` fences don't render as markers — their content becomes a
 * darker-background panel instead.
 */
const CODE_PANEL_BG = "#262626";

function pushAssistantBody(lines: Line[], body: string, width: number): void {
  let inFence = false;
  let code: string[] = [];
  let firstLine = true;

  // Paint the collected code lines as one padded dark panel.
  const flushCode = () => {
    const codeWidth = Math.max(10, width - 6);
    const rows: string[] = [];
    for (const raw of code) {
      if (raw.trim() === "") {
        rows.push("");
        continue;
      }
      rows.push(...wrapText(raw, codeWidth));
    }
    if (rows.length === 0) return;
    const blockWidth = Math.min(width - 2, Math.max(...rows.map((r) => r.length)) + 4);
    for (const row of rows) {
      lines.push({ text: ("  " + row).padEnd(blockWidth), bgColor: CODE_PANEL_BG });
    }
  };

  for (const raw of body.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("```")) {
      if (inFence) {
        flushCode();
        code = [];
      }
      inFence = !inFence;
      continue; // markers themselves never render
    }
    if (inFence) {
      code.push(raw);
      continue;
    }
    const prefix = firstLine ? "halo ❯ " : "  ";
    const prefixColor = firstLine ? "cyan" : undefined;
    pushWrapped(lines, prefix, prefixColor, raw, {}, width);
    firstLine = false;
  }
  if (inFence) flushCode(); // unclosed fence at end of body
}

function pushWrapped(
  lines: Line[],
  prefix: string,
  prefixColor: string | undefined,
  body: string,
  style: { color?: string; dim?: boolean; italic?: boolean },
  width: number,
  spacing = 0, // optional: blank lines added below the pushed content
): void {
  const firstWidth = Math.max(10, width - prefix.length);
  const wrapped = wrapText(body, firstWidth);
  wrapped.forEach((text, i) => {
    if (i === 0 && prefix) {
      lines.push({ prefix, prefixColor, text, ...style });
    } else {
      lines.push({ prefix: "  ", text, ...style });
    }
  });
  for (let i = 0; i < Math.max(0, Math.floor(spacing)); i++) {
    lines.push({ text: "" });
  }
}

// ---- plain-stdout printing (no TUI) ------------------------------------------

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
  const t0 = Date.now();
  const timer = setInterval(() => {
    const secs = Math.floor((Date.now() - t0) / 1000);
    process.stdout.write(
      `\r\x1b[K${cyan(FRAMES[i % FRAMES.length]!)} ${dim(`${label} · ${secs}s`)}`,
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
        process.stdout.write(`${yellow("✻ thinking")}\n`);
        phase = "reasoning";
      }
      process.stdout.write(gray(text));
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
