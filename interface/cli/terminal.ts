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
  /** Multi-part row (e.g. prose with inline-code chips). Overrides text. */
  parts?: LinePart[];
}

/** One styled fragment of a multi-part row. */
export interface LinePart {
  text: string;
  color?: string;
  bgColor?: string;
  dim?: boolean;
  italic?: boolean;
}

/** Activity rows (tool calls/results) visible before collapsing. */
const MAX_ACTIVITY_VISIBLE = 4;

/** Renders the chat data as lines (prefixes, colors, spacing). */
export function renderChat(
  messages: readonly SessionEntry[],
  opts: {
    width: number;
    busy: boolean;
    frame: string;
    elapsed: number;
    modelId: string;
    /** ctrl+o toggle: show every tool line instead of the collapsed tail. */
    expanded?: boolean;
  },
): Line[] {
  const lines: Line[] = [];
  const expanded = opts.expanded === true;
  let haloShown = false; // halo ❯ appears once per user request

  // Consecutive info entries (tool calls + results) form activity runs —
  // rendered as a bounded window so thinking can't flood the transcript.
  let run: SessionEntry[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    const hidden = expanded ? 0 : Math.max(0, run.length - MAX_ACTIVITY_VISIBLE);
    if (hidden > 0) {
      lines.push({
        text: `· ⋯ ${hidden} earlier tool line${hidden === 1 ? "" : "s"} hidden (ctrl+o to expand)`,
        dim: true,
        italic: true,
      });
    }
    for (const entry of expanded ? run : run.slice(-MAX_ACTIVITY_VISIBLE)) {
      lines.push({ text: `· ${entry.text}`, dim: true });
    }
    run = [];
  };

  for (const m of messages) {
    if (m.role === "info") {
      run.push(m);
      continue;
    }
    flushRun();
    // Blank line before conversation turns only — activity and thinking
    // lines hug whatever came above them, no wasted rows.
    for (let i = 0; i < 1; i++) lines.push({ text: "" });
    switch (m.role) {
      case "user":
        haloShown = false; // next request shows halo ❯ again
        pushWrapped(lines, "you ❯ ", "magentaBright", m.text, {}, opts.width);
        break;
      case "assistant":
        if (m.text) {
          pushAssistantBody(lines, m.text, opts.width, !haloShown);
          haloShown = true; // continuation rounds flow without the prefix
        }
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
  flushRun();
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

/** Darker panel background shared by code blocks and inline chips. */
const CODE_PANEL_BG = "#262626";

/** Inline code chip: blue on the code-panel background. */
const INLINE_CODE_STYLE = { color: "blue", bgColor: CODE_PANEL_BG };

/** Split a prose line into plain and `inline-code` segments. */
function splitInlineCode(text: string): Array<{ text: string; code?: boolean }> {
  return text
    .split("`")
    .map((part, i) => (i % 2 === 1 ? { text: part, code: true as const } : { text: part }))
    .filter((seg) => seg.text.length > 0);
}

/** Push one prose row of segments, wrapping words across rows. */
function pushProse(
  lines: Line[],
  segs: Array<{ text: string; code?: boolean }>,
  prefix: string,
  prefixColor: string | undefined,
  width: number,
): void {
  interface Token {
    text: string;
    code?: boolean;
  }
  const tokens: Token[] = [];
  for (const seg of segs) {
    if (seg.code) {
      tokens.push({ text: seg.text, code: true });
      continue;
    }
    for (const word of seg.text.split(" ")) {
      if (word) tokens.push({ text: word });
    }
  }

  const rows: Token[][] = [];
  let row: Token[] = [];
  let len = prefix.length;
  let pendingSpace = false;
  for (const token of tokens) {
    const need = (pendingSpace ? 1 : 0) + token.text.length;
    const rowWidth = rows.length === 0 ? Math.max(10, width - prefix.length) : Math.max(10, width - 2);
    if (len + need > rowWidth && row.length > 0) {
      rows.push(row);
      row = [];
      len = 2; // continuation rows carry the "  " indent
      pendingSpace = false;
    }
    len += need;
    row.push(token);
    pendingSpace = true;
  }
  rows.push(row);

  rows.forEach((tokensForRow, rowIdx) => {
    const parts: LinePart[] = [];
    tokensForRow.forEach((token, i) => {
      if (i > 0) parts.push({ text: " " });
      parts.push(
        token.code
          ? { text: token.text, ...INLINE_CODE_STYLE }
          : { text: token.text },
      );
    });
    const isFirst = rowIdx === 0;
    lines.push({
      text: "",
      prefix: isFirst ? prefix : "  ",
      prefixColor: isFirst ? prefixColor : undefined,
      parts,
    });
  });
}

/**
 * Assistant body renderer: prose carries the halo ❯ prefix on the first
 * line — but only when `showPrefix` is set (it's shown once per user
 * request; continuation rounds after tool calls flow without it).
 * Inline `code` spans render as blue chips. ``` fences don't render as
 * markers — their content becomes a darker-background panel instead.
 */

function pushAssistantBody(
  lines: Line[],
  body: string,
  width: number,
  showPrefix = true,
): void {
  let inFence = false;
  let code: string[] = [];
  let firstLine = showPrefix;

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
      // highlight first, then pad: every part carries the panel bg so the
      // block stays one solid panel
      const parts = highlightCode(row);
      const first = parts[0];
      if (first) first.text = "  " + first.text;
      const used = parts.reduce((n, p) => n + p.text.length, 0);
      const pad = blockWidth - used;
      if (pad > 0) parts.push({ text: " ".repeat(pad), bgColor: CODE_PANEL_BG });
      lines.push({ text: "", parts });
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
    const segs = splitInlineCode(raw);
    if (segs.length === 0) {
      lines.push({ text: "" }); // blank line inside prose
    } else {
      pushProse(lines, segs, prefix, prefixColor, width);
    }
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

// ---- syntax highlighting (VS Code Dark+ palette) -----------------------------

const VS_KEYWORD = "#569CD6"; // const, class, export, return-type words
const VS_CONTROL = "#C586C0"; // if, for, return, await...
const VS_TYPE = "#4EC9B0"; // class names / types
const VS_FUNCTION = "#DCDCAA"; // called functions
const VS_STRING = "#CE9178";
const VS_COMMENT = "#6A9955";
const VS_NUMBER = "#B5CEA8";

const CONTROL_WORDS = new Set([
  "if", "else", "for", "while", "return", "switch", "case", "break",
  "continue", "do", "try", "catch", "throw", "finally",
]);
const KEYWORDS = new Set([
  "const", "let", "var", "function", "class", "export", "import", "from",
  "new", "this", "extends", "implements", "type", "interface", "enum",
  "async", "await", "of", "in", "typeof", "instanceof", "public", "private",
  "readonly", "static", "default", "null", "undefined", "true", "false",
  "void", "string", "number", "boolean", "any", "unknown", "never",
]);

function classifyWord(word: string, rest: string): string | undefined {
  if (CONTROL_WORDS.has(word)) return VS_CONTROL;
  if (KEYWORDS.has(word)) return VS_KEYWORD;
  if (/^\s*\(/.test(rest)) return VS_FUNCTION; // called function
  if (/^[A-Z]/.test(word)) return VS_TYPE; // class/type identifier
  return undefined;
}

/**
 * Tokenize one code line into VS Code Dark+ colored parts. Every part
 * carries the panel bg so highlighted rows stay one solid block.
 */
function highlightCode(line: string): LinePart[] {
  const out: LinePart[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (line.startsWith("//", i)) {
      out.push({ text: line.slice(i), color: VS_COMMENT, bgColor: CODE_PANEL_BG });
      i = line.length;
      break;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) {
        if (line[j] === "\\") j++; // skip escaped quote
        j++;
      }
      out.push({ text: line.slice(i, j + 1), color: VS_STRING, bgColor: CODE_PANEL_BG });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < line.length && /[0-9._]/.test(line[j]!)) j++;
      out.push({ text: line.slice(i, j), color: VS_NUMBER, bgColor: CODE_PANEL_BG });
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < line.length && /[\w$]/.test(line[j]!)) j++;
      const word = line.slice(i, j);
      out.push({
        text: word,
        color: classifyWord(word, line.slice(j)),
        bgColor: CODE_PANEL_BG,
      });
      i = j;
      continue;
    }
    out.push({ text: ch, bgColor: CODE_PANEL_BG });
    i++;
  }

  // merge runs of the same style into fewer parts
  const merged: LinePart[] = [];
  for (const part of out) {
    const last = merged[merged.length - 1];
    if (last && last.color === part.color) last.text += part.text;
    else merged.push({ ...part });
  }
  return merged;
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
