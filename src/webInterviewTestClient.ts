/**
 * Test-only client for the `generate --web` interview server: reads the SSE
 * snapshot stream and posts answers, standing in for the browser page. Used
 * by webInterview.test.ts and cli.test.ts; not packed or exported.
 */

export interface InterviewSnapshot {
  revision: number;
  behavior: string;
  state: {
    type: "loading" | "step" | "done" | "error";
    stepId?: number;
    canGoBack?: boolean;
    step?: Record<string, unknown>;
    written?: string | null;
    message?: string;
  };
}

export class InterviewClient {
  private buffer = "";
  private readonly decoder = new TextDecoder();
  private readonly queue: InterviewSnapshot[] = [];

  private constructor(
    private readonly origin: string,
    private readonly token: string,
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
  ) {}

  static async connect(url: string): Promise<InterviewClient> {
    const parsed = new URL(url);
    const token = parsed.searchParams.get("token") ?? "";
    const response = await fetch(`${parsed.origin}/events?token=${encodeURIComponent(token)}`);
    if (!response.ok || response.body === null) {
      throw new Error(`events stream connect failed with status ${response.status}`);
    }
    return new InterviewClient(parsed.origin, token, response.body.getReader());
  }

  /** Next snapshot pushed by the server (the connect-time state counts). */
  async next(): Promise<InterviewSnapshot> {
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
            this.queue.push(JSON.parse(line.slice("data: ".length)) as InterviewSnapshot);
          }
        }
      }
    }
  }

  /** Next snapshot whose state is a step (skips the loading screen). */
  async nextStep(): Promise<InterviewSnapshot> {
    for (;;) {
      const snapshot = await this.next();
      if (snapshot.state.type === "step") return snapshot;
      if (snapshot.state.type !== "loading") {
        throw new Error(`expected a step snapshot, got ${snapshot.state.type}`);
      }
    }
  }

  async answer(stepId: number, answer: unknown): Promise<number> {
    const response = await fetch(`${this.origin}/answer?token=${encodeURIComponent(this.token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stepId, answer }),
    });
    await response.arrayBuffer();
    return response.status;
  }

  async back(): Promise<number> {
    const response = await fetch(`${this.origin}/back?token=${encodeURIComponent(this.token)}`, {
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
 * Feed scripted answers to steps as they arrive on an already-connected
 * client; resolves with the terminal (done/error) snapshot.
 */
export async function driveConnected(
  client: InterviewClient,
  answers: unknown[],
): Promise<InterviewSnapshot> {
  const remaining = [...answers];
  for (;;) {
    const snapshot = await client.next();
    if (snapshot.state.type === "done" || snapshot.state.type === "error") return snapshot;
    if (snapshot.state.type !== "step") continue;
    const answer = remaining.shift();
    if (answer === undefined) {
      throw new Error(`ran out of scripted answers at step ${snapshot.state.stepId}`);
    }
    const status = await client.answer(snapshot.state.stepId!, answer);
    if (status !== 200) {
      throw new Error(`scripted answer rejected with status ${status}`);
    }
  }
}

/** Connect to a printed interview URL and drive it with scripted answers. */
export async function driveInterview(url: string, answers: unknown[]): Promise<InterviewSnapshot> {
  const client = await InterviewClient.connect(url);
  try {
    return await driveConnected(client, answers);
  } finally {
    client.close();
  }
}
