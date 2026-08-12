/**
 * Test-only client for the `judge --web` report server: reads the SSE
 * snapshot stream and posts the ack the browser page would send once it has
 * rendered the final report. Used by webReport.test.ts and cli.test.ts; not
 * packed or exported.
 */

export interface ReportSnapshot {
  revision: number;
  behavior: string;
  state: {
    type: "judging" | "report" | "error";
    done?: number;
    total?: number;
    judgingId?: string;
    judgments?: Array<Record<string, unknown>>;
    message?: string;
  };
}

export class ReportClient {
  private buffer = "";
  private readonly decoder = new TextDecoder();
  private readonly queue: ReportSnapshot[] = [];

  private constructor(
    private readonly origin: string,
    private readonly token: string,
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
  ) {}

  static async connect(url: string): Promise<ReportClient> {
    const parsed = new URL(url);
    const token = parsed.searchParams.get("token") ?? "";
    const response = await fetch(`${parsed.origin}/events?token=${encodeURIComponent(token)}`);
    if (!response.ok || response.body === null) {
      throw new Error(`events stream connect failed with status ${response.status}`);
    }
    return new ReportClient(parsed.origin, token, response.body.getReader());
  }

  /** Next snapshot pushed by the server (the connect-time state counts). */
  async next(): Promise<ReportSnapshot> {
    for (;;) {
      const queued = this.queue.shift();
      if (queued !== undefined) return queued;
      const { done, value } = await this.reader.read();
      if (done) throw new Error("event stream ended before the expected snapshot");
      this.buffer += this.decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = this.buffer.indexOf("\n\n")) !== -1) {
        const frame = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 2);
        for (const line of frame.split("\n")) {
          if (line.startsWith("data: ")) {
            this.queue.push(JSON.parse(line.slice("data: ".length)) as ReportSnapshot);
          }
        }
      }
    }
  }

  async ack(): Promise<number> {
    const response = await fetch(`${this.origin}/ack?token=${encodeURIComponent(this.token)}`, {
      method: "POST",
    });
    await response.arrayBuffer();
    return response.status;
  }

  close(): void {
    void this.reader.cancel().catch(() => {});
  }
}

/**
 * Watch snapshots until the final report arrives (acking it, as the page
 * does) or an error state lands; resolves with every snapshot seen.
 */
export async function watchReport(url: string): Promise<ReportSnapshot[]> {
  const client = await ReportClient.connect(url);
  const snapshots: ReportSnapshot[] = [];
  try {
    for (;;) {
      const snapshot = await client.next();
      snapshots.push(snapshot);
      if (snapshot.state.type === "error") return snapshots;
      if (snapshot.state.type === "report") {
        const status = await client.ack();
        if (status !== 200) {
          throw new Error(`report ack rejected with status ${status}`);
        }
        return snapshots;
      }
    }
  } finally {
    client.close();
  }
}
