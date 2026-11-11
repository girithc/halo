/**
 * The halo chat UI — hook + component in one file, all of it pure
 * presentation. State comes from the AgentSession; renderChat() turns
 * the chat data into lines. Every chat decision — context gathering,
 * the LLM call, tool calling, history — lives in core (in → out).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Box, Text, useApp, useStdout } from "ink";
import type { AgentSession } from "../../core/agent";
import { parseInput } from "../../core/in/input";
import { FRAMES, renderChat } from "./terminal";

/** Slash-command executor (config/registry UX, not chat). */
export interface CommandHandler {
  run(name: string, args: string): Promise<void>;
}

export interface AppProps {
  /** The headless conductor — built by halo.ts, never by the UI. */
  session: AgentSession;
  /** Slash-command executor (registry/config UX). */
  commands?: CommandHandler;
  /** Keyboard capture; auto-false is used by headless smoke tests. */
  interactive?: boolean;
  /** Sent automatically on mount (used by the UI smoke test). */
  initialPrompt?: string;
}

/**
 * UI binding — subscribes the renderer to the AgentSession.
 * Deliberately dumb: it owns only view concerns (draft text,
 * keystrokes, spinner ticks, terminal size).
 */
function useSessionView({
  session,
  commands,
  interactive,
  initialPrompt,
  exit,
  stdout,
}: AppProps & {
  exit: () => void;
  stdout: {
    rows?: number;
    columns?: number;
    on(event: string, cb: () => void): unknown;
    off(event: string, cb: () => void): unknown;
  };
}) {
  // ---- session state ------------------------------------------------------
  const { entries, busy } = useSyncExternalStore(
    (cb) => session.subscribe(cb),
    () => session.state,
  );

  // ---- pure view state ----------------------------------------------------
  const [draft, setDraft] = useState("");
  const [tick, setTick] = useState(0);
  const [rows, setRows] = useState(stdout.rows || 24);
  const [cols, setCols] = useState(stdout.columns || 80);
  // Scroll: 0 = pinned to live tail; N = N lines back into history.
  const [scrollLines, setScrollLines] = useState(0);
  const maxScrollRef = useRef(0);

  const busyRef = useRef(busy);
  busyRef.current = busy;
  const draftRef = useRef("");
  draftRef.current = draft;
  const exitRef = useRef(exit);
  exitRef.current = exit;
  const initialPendingRef = useRef(initialPrompt != null);

  // ---- submit -------------------------------------------------------------
  const submit = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      const parsed = parseInput(text); // core/in decides: command or message
      if (parsed.kind === "command") {
        void commands?.run(parsed.name, parsed.args);
        return;
      }
      setScrollLines(0); // sending a message jumps back to the live tail
      const turn = session.send(parsed.text);
      if (initialPendingRef.current) {
        initialPendingRef.current = false;
        void turn.then(() => exitRef.current());
      }
    },
    [session, commands],
  );
  const submitRef = useRef(submit);
  submitRef.current = submit;

  // ---- keyboard -----------------------------------------------------------

  const handleKey = (chunk: string): void => {
    if (process.env.HALO_KEYDEBUG) {
      console.error(`[raw] ${JSON.stringify(chunk)}`);
    }
    if (chunk === "\x03") {
      if (busyRef.current) session.abort();
      else exitRef.current();
      return;
    }
    if (chunk === "\x04" && !busyRef.current) {
      exitRef.current();
      return;
    }
    if (chunk === "\x1b") {
      if (busyRef.current) session.abort();
      return;
    }
    if (chunk.startsWith("\x1b")) {
      // Scroll keys — work even mid-stream (reading history while busy).
      if (chunk === "\x1b[5~" || chunk === "\x1b[A") {
        // PageUp / Up: further back (clamped to the oldest line).
        const step = chunk === "\x1b[5~" ? Math.max(1, rows - 4) : 1;
        setScrollLines((s) => Math.min(s + step, Math.max(0, maxScrollRef.current)));
        return;
      }
      if (chunk === "\x1b[6~" || chunk === "\x1b[B") {
        // PageDown / Down: toward the live tail.
        const step = chunk === "\x1b[6~" ? Math.max(1, rows - 4) : 1;
        setScrollLines((s) => Math.max(0, s - step));
        return;
      }
      if (chunk === "\x1b[F" || chunk === "\x1b[4~") {
        setScrollLines(0); // End: back to live
        return;
      }
      if (chunk === "\x1b[H" || chunk === "\x1b[1~") {
        setScrollLines(Math.max(0, maxScrollRef.current)); // Home: oldest
        return;
      }
      return; // other sequences — ignored (v1)
    }
    if (chunk === "\x7f" || chunk === "\b") {
      if (!busyRef.current) setDraft((d) => d.slice(0, -1));
      setScrollLines(0);
      return;
    }
    if (chunk === "\r" || chunk === "\n") {
      if (busyRef.current) return;
      const text = draftRef.current;
      setDraft("");
      setScrollLines(0);
      submitRef.current(text);
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
      setScrollLines(0);
      submitRef.current(text);
      return;
    }
    setScrollLines(0);
    setDraft((d) => d + chunk);
  };
  const keyRef = useRef(handleKey);
  keyRef.current = handleKey;

  // ---- effects ------------------------------------------------------------

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
    const pending = initialPrompt;
    if (pending == null) return;
    submitRef.current(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const elapsed = busy ? Math.round(tick * 0.12) : 0;

  return {
    entries,
    busy,
    tick,
    elapsed,
    rows,
    cols,
    modelId: session.modelId,
    draft,
    setDraft,
    scrollLines,
    maxScrollRef,
  };
}

/** The full-screen (alternate screen) chat component. */
export function App({ session, commands, interactive = true, initialPrompt }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const view = useSessionView({ session, commands, interactive, initialPrompt, exit, stdout });

  const frame = FRAMES[view.tick % FRAMES.length]!;
  const width = Math.max(20, view.cols - 2);
  const viewportRows = Math.max(1, view.rows - 4); // 3 rows composer border + 1 status row
  const lines = renderChat(view.entries, {
    width,
    busy: view.busy,
    frame,
    elapsed: view.elapsed,
    modelId: view.modelId,
  });

  // Scroll window: offset 0 = live tail; N = N lines back into history.
  view.maxScrollRef.current = Math.max(0, lines.length - viewportRows);
  const offset = Math.min(view.scrollLines, view.maxScrollRef.current);
  const end = lines.length - offset;
  const visible = lines.slice(Math.max(0, end - viewportRows), end);

  return (
    <Box flexDirection="column" height={view.rows} width="100%">
      <Box
        flexDirection="column"
        height={viewportRows}
        overflow="hidden"
        justifyContent={offset > 0 ? "flex-start" : "flex-end"}
      >
        {visible.map((line, i) => (
          <Text key={i}>
            {line.prefix && <Text color={line.prefixColor}>{line.prefix}</Text>}
            <Text
              color={line.color}
              backgroundColor={line.bgColor}
              dimColor={line.dim}
              italic={line.italic}
            >
              {/* ink collapses empty text to zero height — a lone space
                  is what makes a blank line actually occupy a row */}
              {line.text === "" ? " " : line.text}
            </Text>
          </Text>
        ))}
      </Box>

      <Box borderStyle="round" borderColor={view.busy ? "gray" : "cyan"} paddingX={1}>
        <Text color={view.busy ? "gray" : "cyan"}>{view.busy ? "…" : "❯"} </Text>
        <Text>{view.draft}</Text>
        {!view.busy && <Text backgroundColor="white"> </Text>}
      </Box>
      <Box justifyContent="space-between" width="100%">
        <Text dimColor>{" " + view.modelId}</Text>
        <Text dimColor>
          {view.busy
            ? "esc to interrupt "
            : offset > 0
              ? `history · ${offset} back · End to return `
              : "/help commands · ctrl-c to quit "}
        </Text>
      </Box>
    </Box>
  );
}
