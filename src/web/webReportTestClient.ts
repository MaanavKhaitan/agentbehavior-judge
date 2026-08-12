/**
 * Test-only client for the `judge` web report server: reads the SSE
 * snapshot stream and posts the ack the browser page would send once it has
 * rendered the final report. Used by webReport.test.ts and cli.test.ts; not
 * packed or exported.
 */

import { openSnapshotStream, SnapshotClient } from "./sseTestClient.js";

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

export class ReportClient extends SnapshotClient<ReportSnapshot> {
  static async connect(url: string): Promise<ReportClient> {
    return new ReportClient(await openSnapshotStream(url));
  }

  ack(): Promise<number> {
    return this.post("/ack");
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
