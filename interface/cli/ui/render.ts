/**
 * Rendering: chat data -> renderable lines. Pure functions, no React.
 */
import type { ChatEntry, Line } from "./types";

export const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Renders the chat data as lines (prefixes, colors, spacing). */
export function renderChat(
  messages: ChatEntry[],
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
    lines.push({ text: "" }); // one blank line before every turn
    switch (m.role) {
      case "user":
        pushWrapped(lines, "you ❯ ", "magentaBright", m.text, {}, opts.width, 0.5);
        break;
      case "assistant":
        if (m.text) pushWrapped(lines, "halo ❯ ", "cyan", m.text, {}, opts.width, 1);
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

/** Greedy word wrap on plain text (long words hard-split). */
function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(" ")) {
      let w = word;
      if (!line) {
        while (w.length > width) {
          out.push(w.slice(0, width));
          w = w.slice(width);
        }
        line = w;
      } else if ((line + " " + w).length <= width) {
        line += " " + w;
      } else {
        out.push(line);
        while (w.length > width) {
          out.push(w.slice(0, width));
          w = w.slice(width);
        }
        line = w;
      }
    }
    out.push(line);
  }
  return out;
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
