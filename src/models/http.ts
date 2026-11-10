/** Shared wire-protocol plumbing for model providers. */

/**
 * Yields the payload of every `data:` line in an SSE body.
 * Blank lines, `event:`/`id:`/retry lines and comments are skipped.
 */
export async function* sseDataEvents(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data) yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Best-effort readable message from an error response. */
export async function describeError(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  try {
    const json = JSON.parse(body) as { error?: unknown; message?: string };
    const text = errorText(json.error) || json.message;
    return text || `HTTP ${res.status} ${res.statusText}`;
  } catch {
    return body ? body.slice(0, 300) : `HTTP ${res.status} ${res.statusText}`;
  }
}

/** Pulls a human message out of `unknown` error shapes. */
export function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}
