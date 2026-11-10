/**
 * The halo TUI — an Ink (React for terminals) app, same foundation as
 * Claude Code. Completed turns stream into scrollback via <Static>;
 * the live area shows reasoning + streaming answer + waiting spinner;
 * a boxed composer sits pinned at the bottom.
 */
import { Box, Static, Text, useApp, useInput, type Key } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { MODEL_PRESETS, type ModelRegistry } from "../../../models/registry";
import type { ChatMessage } from "../../../models/types";
import { configPath, saveConfig } from "../../../secrets/config";
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

export function App({ registry, apiKey, interactive = true, initialPrompt }: AppProps) {
  const { exit } = useApp();
  const [turns, setTurns] = useState<Turn[]>([
    { role: "info", content: `halo · ${registry.active().id} · /help for commands` },
  ]);
  const [input, setInput] = useState("");
  const [live, setLive] = useState<{ reasoning: string; answer: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const historyRef = useRef<ChatMessage[]>([{ role: "system", content: SYSTEM_PROMPT }]);
  const inputRef = useRef("");
  inputRef.current = input;
  const bootRef = useRef(false);
  const initialPendingRef = useRef(initialPrompt != null);

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
            info(`✓ ${preset.id} @ ${preset.baseURL} (session only)`);
          } else {
            registry.setModelId(args);
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
      setLive({ reasoning: "", answer: "" });

      const ac = new AbortController();
      abortRef.current = ac;
      let answer = "";
      let reasoning = "";
      let sawOutput = false;
      const started = Date.now();
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
        const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
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

  const handleKey = (value: string, key: Key): void => {
    if (key.escape) {
      if (busyRef.current) abortRef.current?.abort();
      return;
    }
    if (key.ctrl && value === "c") {
      if (busyRef.current) abortRef.current?.abort();
      else exit();
      return;
    }
    if (busyRef.current) return; // ignore typing mid-stream (v1)
    if (key.return) {
      const text = inputRef.current;
      setInput("");
      void submitRef.current(text);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((v) => v.slice(0, -1));
      return;
    }
    if (
      key.upArrow || key.downArrow || key.leftArrow || key.rightArrow ||
      key.tab || key.ctrl || key.meta
    ) {
      return;
    }
    if (value) setInput((v) => v + value);
  };
  const keyRef = useRef(handleKey);
  keyRef.current = handleKey;

  // Auto-send the initial prompt exactly once (UI smoke test uses this).
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    if (initialPrompt != null) void submitRef.current(initialPrompt);
  }, [initialPrompt]);

  return (
    <Box flexDirection="column">
      {interactive && <Keyboard handlerRef={keyRef} />}
      <Static items={turns}>
        {(turn, i) => <TurnView key={i} turn={turn} />}
      </Static>

      {live && (
        <Box flexDirection="column">
          {!live.answer && !live.reasoning && (
            <WaitingLine label={`waiting · ${registry.active().id}`} />
          )}
          {live.reasoning && !live.answer && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="yellow">✻ thinking</Text>
              <Text dimColor>{tailLines(live.reasoning, 4)}</Text>
            </Box>
          )}
          {live.answer.length > 0 && (
            <Box marginTop={1}>
              <Text color="cyan">halo ❯ </Text>
              <Text>{live.answer}</Text>
            </Box>
          )}
        </Box>
      )}

      <Box
        borderStyle="round"
        borderColor={busy ? "gray" : "cyan"}
        paddingX={1}
        marginTop={1}
      >
        <Text color={busy ? "gray" : "cyan"}>{busy ? "…" : "❯"} </Text>
        <Text>{input}</Text>
        {!busy && <Text backgroundColor="white"> </Text>}
      </Box>
      <Box>
        <Text dimColor>
          {" "}
          {busy
            ? "esc to interrupt"
            : "enter to send · /help commands · ctrl-c to quit"}
        </Text>
      </Box>
    </Box>
  );
}

/**
 * Keyboard capture in its own component so headless renders
 * (piped stdin, no raw mode) can skip it entirely.
 */
function Keyboard({
  handlerRef,
}: {
  handlerRef: { current: (value: string, key: Key) => void };
}) {
  useInput((value, key) => handlerRef.current(value, key));
  return null;
}

/** One completed turn, rendered once into terminal scrollback. */
function TurnView({ turn }: { turn: Turn }) {
  switch (turn.role) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color="magentaBright">you ❯ </Text>
          <Text>{turn.content}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Text>
          <Text color="cyan">halo ❯ </Text>
          {turn.content}
        </Text>
      );
    case "info":
      return <Text dimColor>· {turn.content}</Text>;
    case "thought":
      return <Text dimColor>✻ thought for {turn.seconds}s</Text>;
  }
}

function WaitingLine({ label }: { label: string }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <Text>
      <Text color="cyan">{FRAMES[tick % FRAMES.length]} </Text>
      <Text dimColor>
        {label} · {tick}s
      </Text>
    </Text>
  );
}

function tailLines(text: string, count: number): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return lines.slice(-count).join("\n");
}
