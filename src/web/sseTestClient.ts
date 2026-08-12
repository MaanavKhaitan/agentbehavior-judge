/**
 * Shared machinery for the web test clients (webInterviewTestClient.ts,
 * webReportTestClient.ts): connects to a web server's SSE snapshot stream,
 * parses its frames, and posts JSON back over the tokenized routes. Test-only;
 * not packed or exported.
 */

export interface SseConnection {
  origin: string;
  token: string;
  reader: ReadableStreamDefaultReader<Uint8Array>;
}

export async function openSnapshotStream(url: string): Promise<SseConnection> {
  const parsed = new URL(url);
  const token = parsed.searchParams.get("token") ?? "";
  const response = await fetch(`${parsed.origin}/events?token=${encodeURIComponent(token)}`);
  if (!response.ok || response.body === null) {
    throw new Error(`events stream connect failed with status ${response.status}`);
  }
  return { origin: parsed.origin, token, reader: response.body.getReader() };
}

export class SnapshotClient<TSnapshot> {
  private buffer = "";
  private readonly decoder = new TextDecoder();
  private readonly queue: TSnapshot[] = [];

  protected constructor(private readonly connection: SseConnection) {}

  /** Next snapshot pushed by the server (the connect-time state counts). */
  async next(): Promise<TSnapshot> {
    for (;;) {
      const queued = this.queue.shift();
      if (queued !== undefined) return queued;
      const { done, value } = await this.connection.reader.read();
      if (done) throw new Error("event stream ended before the expected snapshot");
      this.buffer += this.decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = this.buffer.indexOf("\n\n")) !== -1) {
        const frame = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 2);
        for (const line of frame.split("\n")) {
          if (line.startsWith("data: ")) {
            this.queue.push(JSON.parse(line.slice("data: ".length)) as TSnapshot);
          }
        }
      }
    }
  }

  /** POST a JSON body to a tokenized route; resolves with the HTTP status. */
  protected async post(pathname: string, body?: unknown): Promise<number> {
    const { origin, token } = this.connection;
    const response = await fetch(`${origin}${pathname}?token=${encodeURIComponent(token)}`, {
      method: "POST",
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    await response.arrayBuffer();
    return response.status;
  }

  close(): void {
    void this.connection.reader.cancel().catch(() => {});
  }
}
