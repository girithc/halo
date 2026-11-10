/**
 * The halo chat UI — full-screen (alternate screen).
 * Pure rendering: state + actions come from useChat(),
 * renderChat() turns the chat data into lines.
 */
import { Box, Text, useApp, useStdout } from "ink";
import { FRAMES, renderChat } from "./render";
import { useChat } from "./useChat";
import type { AppProps } from "./types";

export function App({ registry, apiKey, interactive = true, initialPrompt }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const chat = useChat({ registry, apiKey, interactive, initialPrompt, exit, stdout });

  const frame = FRAMES[chat.tick % FRAMES.length]!;
  const width = Math.max(20, chat.cols - 2);
  const viewportRows = Math.max(1, chat.rows - 4); // 3 rows composer border + 1 status row
  const lines = renderChat(chat.messages, {
    width,
    busy: chat.busy,
    frame,
    elapsed: chat.elapsed,
    modelId: chat.modelId,
  });
  const visible = lines.slice(-viewportRows);

  return (
    <Box flexDirection="column" height={chat.rows} width="100%">
      <Box
        flexDirection="column"
        height={viewportRows}
        overflow="hidden"
        justifyContent="flex-end"
      >
        {visible.map((line, i) => (
          <Text key={i}>
            {line.prefix && <Text color={line.prefixColor}>{line.prefix}</Text>}
            <Text color={line.color} dimColor={line.dim} italic={line.italic}>
              {/* ink collapses empty text to zero height — a lone space
                  is what makes a blank line actually occupy a row */}
              {line.text === "" ? " " : line.text}
            </Text>
          </Text>
        ))}
      </Box>

      <Box borderStyle="round" borderColor={chat.busy ? "gray" : "cyan"} paddingX={1}>
        <Text color={chat.busy ? "gray" : "cyan"}>{chat.busy ? "…" : "❯"} </Text>
        <Text>{chat.draft}</Text>
        {!chat.busy && <Text backgroundColor="white"> </Text>}
      </Box>
      <Box justifyContent="space-between" width="100%">
        <Text dimColor>{" " + chat.modelId}</Text>
        <Text dimColor>
          {chat.busy ? "esc to interrupt " : "/help commands · ctrl-c to quit "}
        </Text>
      </Box>
    </Box>
  );
}
