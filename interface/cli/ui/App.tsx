/**
 * The halo chat UI — full-screen (alternate screen).
 *
 * Architecture is deliberately simple:
 *   messages  <- the chat data. The UI only reads this; every change is a
 *                setState, and React repaints the sections above the input bar.
 *   draft     <- what's typed in the input bar.
 *   busy      <- spinner/elapsed status while the reply streams.
 *
 * Actions: sendMessage() streams the reply into `messages`,
 * runCommand() handles /commands, everything else is keyboard plumbing.
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

/** One entry in the chat data. The UI is a pure function of this. */
export interface ChatEntry {
  id: number;
  role: "user" | "assistant" | "info" | "thought";
  text: string;
  seconds?: number;
}

export interface AppProps {
  registry: ModelRegistry;
  apiKey: string;
  /** Keyboard capture; auto-false is used by headless smoke tests. */
  interactive?: boolean;
  /** Sent automatically on mount (used by the UI smoke test). */
  initialPrompt?: string;
}

/** One renderable row (prefix + styled text). */
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

  // ---- chat data ----------------------------------------------------------
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [rows, setRows] = useState(stdout.rows || 24);
  const [cols, setCols] = useState(stdout.columns || 80);

  const nextId = useRef(1);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const startedRef = useRef(0);
  const draftRef = useRef("");
  draftRef.current = draft;
  const historyRef = useRef<ChatMessage[]>([{ role: "system", content: SYSTEM_PROMPT }]);
  const bootRef = useRef(false);
  const initialPendingRef = useRef(initialPrompt != null);

  const addMessage = useCallback((entry: Omit<ChatEntry, "id">) => {
    const id = nextId.current++;
    setMessages((all) => [...all, { ...entry, id }]);
  }, []);

  /** Grow the last assistant message in place as chunks arrive. */
  const updateLastAssistant = useCallback((text: string) => {
    setMessages((all) => {
      const idx = all.map((m) => m.role).lastIndexOf("assistant");
      if (idx === -1) return all;
      const next = [...all];
      next[idx] = { ...next[idx]!, text };
      return next;
    });
  }, []);

  const dropLastAssistant = useCallback(() => {
    setMessages((all) => {
      const idx = all.map((m) => m.role).lastIndexOf("assistant");
      if (idx === -1) return all;
      return [...all.slice(0, idx), ...all.slice(idx + 1)];
    });
  }, []);

  // ---- actions ------------------------------------------------------------
  const runCommand = useCallback(
    async (text: string) => {
      const [name = "", ...rest] = text.slice(1).split(/\s+/);
      const args = rest.join(" ");
      switch (name.toLowerCase()) {
        case "help":
          addMessage({ role: "info", text: HELP_TEXT });
          return;
        case "model": {
          if (!args) {
            addMessage({
              role: "info",
              text: `active model: ${registry.active().id} @ ${registry.active().baseURL}`,
            });
            return;
          }
          const preset = MODEL_PRESETS[args.toLowerCase()];
          if (preset) {
            registry.setConfig(preset);
            addMessage({ role: "info", text: `✓ ${preset.id} @ ${preset.baseURL} (session only)` });
          } else {
            registry.setModelId(args);
            addMessage({ role: "info", text: `✓ model set to ${args} (session only — /config persists)` });
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
          addMessage({ role: "info", text: `✓ saved ${active.id} → ${path}` });
          return;
        }
        case "clear":
          historyRef.current = [{ role: "system", content: SYSTEM_PROMPT }];
          setMessages([]);
          return;
        case "quit":
        case "exit":
        case "q":
          exit();
          return;
        default:
          addMessage({ role: "info", text: `unknown command /${name} — try /help` });
      }
    },
    [registry, addMessage, exit],
  );
  const sendMessage = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || busyRef.current) return;
      if (text.startsWith("/")) {
        await runCommand(text);
        return;
      }

      addMessage({ role: "user", text });
      historyRef.current.push({ role: "user", content: text });
      addMessage({ role: "assistant", text: "" }); // fills in as chunks arrive
      busyRef.current = true;
      setBusy(true);
      setTick(0);
      startedRef.current = Date.now();

      const ac = new AbortController();
      abortRef.current = ac;
      let reply = "";
      let reasoning = false;
      try {
        const auth =
          (await resolveApiKey(registry.active().apiKeyEnv)) ?? {
            key: apiKey,
            source: "session",
          };
        for await (const chunk of registry
          .createProvider(auth.key)
          .chat(historyRef.current, ac.signal)) {
          if (chunk.kind === "reasoning") reasoning = true;
          else {
            reply += chunk.text;
            updateLastAssistant(reply);
          }
        }
      } catch (err) {
        const msg = ac.signal.aborted
          ? "cancelled"
          : err instanceof Error
            ? err.message
            : String(err);
        addMessage({ role: "info", text: msg });
      } finally {
        const seconds = Math.max(
          1,
          Math.round((Date.now() - startedRef.current) / 1000),
        );
        if (reply) {
          historyRef.current.push({ role: "assistant", content: reply });
          if (reasoning) addMessage({ role: "thought", text: "", seconds });
        } else {
          dropLastAssistant(); // nothing arrived — don't leave an empty bubble
          if (!ac.signal.aborted) {
            addMessage({ role: "info", text: "(no answer received)" });
          }
        }
        setBusy(false);
        busyRef.current = false;
        abortRef.current = null;
        if (initialPendingRef.current) {
          initialPendingRef.current = false;
          exit();
        }
      }
    },
    [registry, apiKey, runCommand, addMessage, updateLastAssistant, dropLastAssistant, exit],
  );

  const commandRef = useRef(runCommand);
  commandRef.current = runCommand;

  // ---- keyboard -----------------------------------------------------------
  const handleKey = (chunk: string): void => {
    if (process.env.HALO_KEYDEBUG) {
      console.error(`[raw] ${JSON.stringify(chunk)}`);
    }
    if (chunk === "\x03") {
      if (busyRef.current) abortRef.current?.abort();
      else exit();
      return;
    }
    if (chunk === "\x04" && !busyRef.current) {
      exit();
      return;
    }
    if (chunk === "\x1b") {
      if (busyRef.current) abortRef.current?.abort();
      return;
    }
    if (chunk.startsWith("\x1b")) return; // arrow/function sequences — ignored (v1)
    if (chunk === "\x7f" || chunk === "\b") {
      if (!busyRef.current) setDraft((d) => d.slice(0, -1));
      return;
    }
    if (chunk === "\r" || chunk === "\n") {
      if (busyRef.current) return;
      const text = draftRef.current;
      setDraft("");
      void sendMessage(text);
      return;
    }
    if (busyRef.current) return;
    // Burst/paste chunks can carry the newline inline: submit first line,
    // keep any remainder in the composer.
    const newlineAt = chunk.search(/\r|\n/);
    if (newlineAt >= 0) {
      const head = chunk.slice(0, newlineAt);
      const rest = chunk.slice(newlineAt + 1).replace(/[\r\n]+$/, "");
      const text = draftRef.current + head;
      setDraft(rest);
      void sendMessage(text);
      return;
    }
    setDraft((d) => d + chunk);
  };
  const keyRef = useRef(handleKey);
  keyRef.current = handleKey;

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

  // Spinner while waiting for the model.
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setTick((t) => t + 1), 120);
    return () => clearInterval(timer);
  }, [busy]);

  // Auto-send the initial prompt exactly once (UI smoke test uses this).
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    if (initialPrompt != null) void sendMessage(initialPrompt);
  }, [initialPrompt, sendMessage]);

  // ---- layout: chat section above, input bar pinned to the bottom ---------
  const frame = FRAMES[tick % FRAMES.length]!;
  const elapsed = busy
    ? Math.max(0, Math.round((Date.now() - startedRef.current) / 1000))
    : 0;
  const width = Math.max(20, cols - 2);
  const lines = renderChat(messages, {
    width,
    busy,
    frame,
    elapsed,
    modelId: registry.active().id,
  });
  const viewportRows = Math.max(1, rows - 4); // 3 rows composer border + 1 status row

  return (
    <Box flexDirection="column" height={rows} width="100%">
      <Box
        flexDirection="column"
        height={viewportRows}
        overflow="hidden"
        justifyContent="flex-end"
      >
        {lines.slice(-viewportRows).map((line, i) => (
          <Text key={i}>
            {line.prefix && <Text color={line.prefixColor}>{line.prefix}</Text>}
            <Text color={line.color} dimColor={line.dim} italic={line.italic}>
              {line.text}
            </Text>
          </Text>
        ))}
      </Box>

      <Box borderStyle="round" borderColor={busy ? "gray" : "cyan"} paddingX={1}>
        <Text color={busy ? "gray" : "cyan"}>{busy ? "…" : "❯"} </Text>
        <Text>{draft}</Text>
        {!busy && <Text backgroundColor="white"> </Text>}
      </Box>
      <Box justifyContent="space-between" width="100%">
        <Text dimColor>{" " + registry.active().id}</Text>
        <Text dimColor>
          {busy ? "esc to interrupt " : "/help commands · ctrl-c to quit "}
        </Text>
      </Box>
    </Box>
  );
}

// ---- rendering: chat data -> lines -----------------------------------------

/** Renders the chat data as lines (prefixes, colors, spacing). */
function renderChat(
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
    const gap = m.role === "user" ? 2 : 1;
    for (let i = 0; i < gap; i++) lines.push({ text: "" });
    switch (m.role) {
      case "user":
        pushWrapped(lines, "you ❯ ", "magentaBright", m.text, {}, opts.width);
        break;
      case "assistant":
        if (m.text) pushWrapped(lines, "halo ❯ ", "cyan", m.text, {}, opts.width);
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

// ---- text helpers -----------------------------------------------------------

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
