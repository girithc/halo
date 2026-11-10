/**
 * The halo TUI — full-screen (alternate screen), like Claude Code / Codex.
 * The whole terminal becomes the harness: a transcript viewport above,
 * the composer pinned to the bottom row, status line underneath.
 */
import { Box, Text, useApp, useStdout } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { MODEL_PRESETS, type ModelRegistry } from "../../../models/registry";
import type { ChatMessage } from "../../../models/types";
import { saveConfig } from "../../../secrets/config";
import { resolveApiKey } from "../../../secrets/store";

export const SYSTEM_PROMPT =
  "You are halo, a concise terminal coding agent. " +
  "Answer in plain text, use fenced code blocks for code, and keep it short.";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const HELP_TEXT = [
  "commands:",
  "  /model                show the active model",
  "  /model <id|preset>    switch model for this session (presets: " +
    Object.keys(MODEL_PRESETS).join(", ") + ")",
  "  /config               persist current setup to ~/.halo/config.json",
  "  /clear                reset conversation history",
  "  /quit                 exit",
  "keys:",
  "  esc                   interrupt the current reply",
  "  ctrl-c                interrupt (or quit when idle)",
].join("\n");

export type Turn =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "info"; content: string }
  | { role: "thought"; seconds: number };

export interface AppProps {
  registry: ModelRegistry;
  apiKey: string;
  /** Keyboard capture; auto-false is used by headless smoke tests. */
  interactive?: boolean;
  /** Sent automatically on mount (used by the UI smoke test). */
  initialPrompt?: string;
}

/** One renderable row of the transcript viewport. */
interface Line {
  prefix?: string;
  prefixColor?: string;
  text: string;
  color?: string;
  dim?: boolean;
  italic?: boolean;
}

export function App({ registry, apiKey, interactive = true, initialPrompt }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [rows, setRows] = useState(stdout.rows || 24);
  const [cols, setCols] = useState(stdout.columns || 80);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [live, setLive] = useState<{ reasoning: string; answer: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [modelId, setModelId] = useState(registry.active().id);
  const [tick, setTick] = useState(0);

  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const historyRef = useRef<ChatMessage[]>([{ role: "system", content: SYSTEM_PROMPT }]);
  const inputRef = useRef("");
  inputRef.current = input;
  const bootRef = useRef(false);
  const initialPendingRef = useRef(initialPrompt != null);
  const busyStartRef = useRef(0);

  // Follow terminal resizes so the full-screen layout always fits.
  useEffect(() => {
    const onResize = () => {
      setRows(stdout.rows || 24);
      setCols(stdout.columns || 80);
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  // Spinner + elapsed seconds while waiting/streaming.
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setTick((t) => t + 1), 120);
    return () => clearInterval(timer);
  }, [busy]);

  const info = useCallback((content: string) => {
    setTurns((t) => [...t, { role: "info", content }]);
  }, []);

  const runCommand = useCallback(
    async (text: string) => {
      const [name = "", ...rest] = text.slice(1).split(/\s+/);
      const args = rest.join(" ");
      switch (name.toLowerCase()) {
        case "help":
          info(HELP_TEXT);
          return;
        case "model": {
          if (!args) {
            info(`active model: ${registry.active().id} @ ${registry.active().baseURL}`);
            return;
          }
          const preset = MODEL_PRESETS[args.toLowerCase()];
          if (preset) {
            registry.setConfig(preset);
            setModelId(registry.active().id);
            info(`✓ ${preset.id} @ ${preset.baseURL} (session only)`);
          } else {
            registry.setModelId(args);
            setModelId(registry.active().id);
            info(`✓ model set to ${args} (session only — /config persists)`);
          }
          return;
        }
        case "config": {
          const active = registry.active();
          const path = await saveConfig({
            provider: active.name,
            model: active.id,
            baseURL: active.baseURL,
            api: active.api,
            apiKeyEnv: active.apiKeyEnv,
            reasoningEffort: active.reasoningEffort,
          });
          info(`✓ saved ${active.id} → ${path}`);
          return;
        }
        case "clear":
          historyRef.current = [{ role: "system", content: SYSTEM_PROMPT }];
          setTurns([{ role: "info", content: "conversation history cleared" }]);
          return;
        case "quit":
        case "exit":
        case "q":
          exit();
          return;
        default:
          info(`unknown command /${name} — try /help`);
      }
    },
    [registry, info, exit],
  );

  const runSubmit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || busyRef.current) return;
      if (text.startsWith("/")) {
        await runCommand(text);
        return;
      }

      historyRef.current.push({ role: "user", content: text });
      setTurns((t) => [...t, { role: "user", content: text }]);
      busyRef.current = true;
      setBusy(true);
      setModelId(registry.active().id);
      setTick(0);
      busyStartRef.current = Date.now();
      setLive({ reasoning: "", answer: "" });

      const ac = new AbortController();
      abortRef.current = ac;
      let answer = "";
      let reasoning = "";
      let sawOutput = false;
      try {
        const auth =
          (await resolveApiKey(registry.active().apiKeyEnv)) ?? {
            key: apiKey,
            source: "session",
          };
        for await (const chunk of registry
          .createProvider(auth.key)
          .chat(historyRef.current, ac.signal)) {
          sawOutput = true;
          if (chunk.kind === "reasoning") reasoning += chunk.text;
          else answer += chunk.text;
          setLive({ reasoning, answer });
        }
      } catch (err) {
        const msg = ac.signal.aborted
          ? "cancelled"
          : err instanceof Error
            ? err.message
            : String(err);
        setTurns((t) => [...t, { role: "info", content: msg }]);
      } finally {
        const seconds = Math.max(
          1,
          Math.round((Date.now() - busyStartRef.current) / 1000),
        );
        const additions: Turn[] = [];
        if (reasoning) additions.push({ role: "thought", seconds });
        if (answer) {
          historyRef.current.push({ role: "assistant", content: answer });
          additions.push({ role: "assistant", content: answer });
        } else if (!ac.signal.aborted) {
          additions.push({
            role: "info",
            content: sawOutput
              ? "(the model thought, but sent no answer text)"
              : "(no answer received — run HALO_DEBUG=1 halo to inspect the raw stream)",
          });
        }
        setTurns((t) => [...t, ...additions]);
        setLive(null);
        setBusy(false);
        busyRef.current = false;
        abortRef.current = null;
        if (initialPendingRef.current) {
          initialPendingRef.current = false;
          exit();
        }
      }
    },
    [registry, apiKey, runCommand, exit],
  );

  const submitRef = useRef(runSubmit);
  submitRef.current = runSubmit;

  const handleKey = (chunk: string): void => {
    if (process.env.HALO_KEYDEBUG) {
      console.error(`[raw] ${JSON.stringify(chunk)}`);
    }
    if (chunk === "\x03") {
      // ctrl-c: interrupt the running reply, or quit
      if (busyRef.current) abortRef.current?.abort();
      else exit();
      return;
    }
    if (chunk === "\x04" && !busyRef.current) {
      exit(); // ctrl-d
      return;
    }
    if (chunk === "\x1b") {
      // bare esc: interrupt
      if (busyRef.current) abortRef.current?.abort();
      return;
    }
    if (chunk.startsWith("\x1b")) return; // arrow/function sequences — ignored (v1)
    if (chunk === "\x7f" || chunk === "\b") {
      if (!busyRef.current) setInput((v) => v.slice(0, -1));
      return;
    }
    if (chunk === "\r" || chunk === "\n") {
      if (busyRef.current) return;
      const text = inputRef.current;
      setInput("");
      void submitRef.current(text);
      return;
    }
    if (busyRef.current) return;
    // Burst-typed or pasted chunks can arrive with the newline embedded:
    // split and submit the first line, keep any remainder in the composer.
    const newlineAt = chunk.search(/\r|\n/);
    if (newlineAt >= 0) {
      const head = chunk.slice(0, newlineAt);
      const rest = chunk.slice(newlineAt + 1).replace(/[\r\n]+$/, "");
      const text = inputRef.current + head;
      setInput(rest);
      void submitRef.current(text);
      return;
    }
    setInput((v) => v + chunk);
  };
  const keyRef = useRef(handleKey);
  keyRef.current = handleKey;

  // Own raw-mode keyboard handling — ink's useInput is unreliable under Bun.
  useEffect(() => {
    if (!interactive) return;
    const stdin = process.stdin;
    try {
      stdin.setRawMode?.(true);
    } catch {
      // headless — fine
    }
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (data: string) => keyRef.current(data);
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
      try {
        stdin.setRawMode?.(false);
      } catch {
        // ignore
      }
    };
  }, [interactive]);

  // Auto-send the initial prompt exactly once (UI smoke test uses this).
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    if (initialPrompt != null) void submitRef.current(initialPrompt);
  }, [initialPrompt]);

  // ---- full-screen layout -------------------------------------------------
  const frame = FRAMES[tick % FRAMES.length]!;
  const elapsed = busy
    ? Math.max(0, Math.round((Date.now() - busyStartRef.current) / 1000))
    : 0;
  const width = Math.max(20, cols - 2);
  const viewportRows = Math.max(1, rows - 4); // 3 rows composer border + 1 status
  const lines = transcriptLines(turns, live, {
    width,
    frame,
    elapsed,
    modelId,
  });
  const visible = lines.slice(-viewportRows);

  return (
    <Box flexDirection="column" height={rows} width="100%">
      <Box
        flexDirection="column"
        height={rows - 4}
        overflow="hidden"
        justifyContent="flex-end"
      >
        {visible.map((line, i) => (
          <Text key={i}>
            {line.prefix && <Text color={line.prefixColor}>{line.prefix}</Text>}
            <Text color={line.color} dimColor={line.dim} italic={line.italic}>
              {line.text}
            </Text>
          </Text>
        ))}
      </Box>

      <Box
        borderStyle="round"
        borderColor={busy ? "gray" : "cyan"}
        paddingX={1}
      >
        <Text color={busy ? "gray" : "cyan"}>{busy ? "…" : "❯"} </Text>
        <Text>{input}</Text>
        {!busy && <Text backgroundColor="white"> </Text>}
      </Box>
      <Box justifyContent="space-between" width="100%">
        <Text dimColor>{" " + modelId}</Text>
        <Text dimColor>
          {busy ? "esc to interrupt " : "/help commands · ctrl-c to quit "}
        </Text>
      </Box>
    </Box>
  );
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
}

function tailLines(text: string, count: number): string[] {
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(-count);
}

/** Builds the full transcript as renderable lines (viewport clips the tail). */
function transcriptLines(
  turns: Turn[],
  live: { reasoning: string; answer: string } | null,
  opts: { width: number; frame: string; elapsed: number; modelId: string },
): Line[] {
  const lines: Line[] = [];
  for (const turn of turns) {
    // Generous spacing: user turns start a new exchange (2 blank lines),
    // replies and notes get one.
    const gap = turn.role === "user" ? 2 : 1;
    for (let i = 0; i < gap; i++) lines.push({ text: "" });
    switch (turn.role) {
      case "user":
        pushWrapped(lines, "you ❯ ", "magentaBright", turn.content, {}, opts.width);
        break;
      case "assistant":
        pushWrapped(lines, "halo ❯ ", "cyan", turn.content, {}, opts.width);
        break;
      case "info":
        pushWrapped(lines, "", undefined, `· ${turn.content}`, { dim: true }, opts.width);
        break;
      case "thought":
        pushWrapped(
          lines,
          "",
          undefined,
          `✻ thought for ${turn.seconds}s`,
          { dim: true, italic: true },
          opts.width,
        );
        break;
    }
  }

  if (live) {
    lines.push({ text: "" });
    if (!live.answer && !live.reasoning) {
      lines.push({
        prefix: `${opts.frame} `,
        prefixColor: "cyan",
        text: `waiting · ${opts.modelId} · ${opts.elapsed}s`,
        dim: true,
      });
    } else {
      if (live.reasoning && !live.answer) {
        lines.push({ text: "✻ thinking", color: "yellow" });
        for (const text of tailLines(live.reasoning, 3)) {
          lines.push({ text, dim: true });
        }
      }
      if (live.answer) {
        pushWrapped(lines, "halo ❯ ", "cyan", live.answer, {}, opts.width);
      }
    }
  }
  return lines;
}
