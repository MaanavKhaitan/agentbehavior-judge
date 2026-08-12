/**
 * Test-only client for the `generate --web` interview server (plain and
 * `--update`): reads the SSE snapshot stream and posts answers, standing in
 * for the browser page. Used by webInterview.test.ts and cli.test.ts; not
 * packed or exported.
 */

import { openSnapshotStream, SnapshotClient } from "./sseTestClient.js";

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

export class InterviewClient extends SnapshotClient<InterviewSnapshot> {
  static async connect(url: string): Promise<InterviewClient> {
    return new InterviewClient(await openSnapshotStream(url));
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

  answer(stepId: number, answer: unknown): Promise<number> {
    return this.post("/answer", { stepId, answer });
  }

  back(): Promise<number> {
    return this.post("/back");
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
