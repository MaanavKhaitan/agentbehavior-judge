import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { JudgeIr, MetaBehaviorIr } from "./ir.js";
import type { ClauseResult, MetaBehaviorResult, TrajectoryJudgment } from "./judge.js";
import type { AgentTrajectory, TrajectoryCase, TrajectoryEvent } from "./trajectory.js";
import { REPORT_PAGE_HTML } from "./webReportPage.js";

/**
 * Browser presentation of the judge report (`judge --web`).
 *
 * Judging stays in judge.ts; this module renders its results. The server
 * pushes `{revision, behavior, state}` snapshots over SSE exactly like the
 * interview server: a `judging` state per trajectory (with the judgments
 * finished so far, so cards appear as runs complete) and a final `report`
 * state. The page posts `/ack` once it has rendered the final report; that
 * handshake is what lets the CLI exit while guaranteeing a browser actually
 * received the report before the server disappears.
 *
 * Same locality posture as the interview: 127.0.0.1 only, and every route
 * requires the one-time token embedded in the printed URL.
 */

export interface WebReportOptions {
  ir: JudgeIr;
  cases: TrajectoryCase[];
  /** Judges one case; the CLI wires model/verify flags (and stderr progress) here. */
  judgeCase: (trajectoryCase: TrajectoryCase, index: number) => Promise<TrajectoryJudgment>;
  /** Terminal progress lines (the URL and the waiting hint). */
  log: (line: string) => void;
  openBrowser?: (url: string) => void;
  /** Defaults to 0 (a random free port). */
  port?: number;
}

type ReportState =
  | {
      type: "judging";
      done: number;
      total: number;
      judgingId: string;
      judgments: Array<Record<string, unknown>>;
    }
  | { type: "report"; total: number; judgments: Array<Record<string, unknown>> }
  | { type: "error"; message: string };

const EVIDENCE_CONTENT_MAX = 200;

function clip(content: string, max: number): string {
  const flat = content.replaceAll(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function citedEventPayload(event: TrajectoryEvent): Record<string, unknown> {
  return {
    id: event.id,
    actor: event.actor,
    action: event.action,
    content: clip(event.content, EVIDENCE_CONTENT_MAX),
    metadata: event.metadata ?? {},
  };
}

function clausePayload(
  clause: ClauseResult,
  role: "trigger" | "check",
  checkType: string | null,
  eventsById: Map<string, TrajectoryEvent>,
): Record<string, unknown> {
  // Predicate citation descriptions are generated boilerplate ("decided this
  // ordering check"); only model-written descriptions carry meaning.
  const modelCited = clause.kind === "semantic" || clause.verification === "overturned";
  return {
    role,
    kind: clause.kind,
    checkType,
    quote: clause.quote,
    verdict: clause.verdict,
    naReason: clause.naReason,
    verification: clause.verification ?? null,
    reasoning: clause.reasoning ?? null,
    citations: clause.citations.map((citation) => {
      const event = eventsById.get(citation.eventId);
      return {
        eventId: citation.eventId,
        description: modelCited ? citation.description : null,
        event: event === undefined ? null : citedEventPayload(event),
      };
    }),
  };
}

function metaPayload(
  meta: MetaBehaviorResult,
  irMeta: MetaBehaviorIr | undefined,
  eventsById: Map<string, TrajectoryEvent>,
): Record<string, unknown> {
  // Predicate clauses precede semantic ones and appear one per IR check, in
  // order (see judgeMetaBehavior); zip them to recover each check's type.
  let predicateIndex = 0;
  const clauses = meta.clauses.map((clause) => {
    let checkType: string | null = null;
    if (meta.triggered && clause.kind === "predicate") {
      checkType = irMeta?.checks[predicateIndex]?.type ?? null;
      predicateIndex += 1;
    }
    // An untriggered meta's only clause is the trigger explanation.
    return clausePayload(clause, meta.triggered ? "check" : "trigger", checkType, eventsById);
  });
  return {
    name: meta.name,
    verdict: meta.verdict,
    naReason: meta.naReason,
    triggered: meta.triggered,
    semanticTrigger: irMeta !== undefined && !("match" in irMeta.trigger),
    triggerDescription: irMeta?.trigger.description ?? "",
    clauses,
  };
}

function judgmentPayload(
  judgment: TrajectoryJudgment,
  trajectory: AgentTrajectory,
  irByName: Map<string, MetaBehaviorIr>,
): Record<string, unknown> {
  const eventsById = new Map(trajectory.events.map((event) => [event.id, event]));
  return {
    trajectoryId: judgment.trajectoryId,
    description: clip(trajectory.description, EVIDENCE_CONTENT_MAX),
    complete: trajectory.complete,
    eventCount: trajectory.events.length,
    verdict: judgment.verdict,
    metaBehaviors: judgment.metaBehaviors.map((meta) =>
      metaPayload(meta, irByName.get(meta.name), eventsById),
    ),
  };
}

class WebReportSession {
  private revision = 0;
  private state: ReportState = { type: "judging", done: 0, total: 0, judgingId: "", judgments: [] };
  private readonly clients = new Set<ServerResponse>();
  private resolveAck!: () => void;
  /** Resolves once a page has rendered the final report and posted /ack. */
  readonly acked = new Promise<void>((resolve) => {
    this.resolveAck = resolve;
  });

  constructor(private readonly behavior: string) {}

  setJudging(
    done: number,
    total: number,
    judgingId: string,
    judgments: Array<Record<string, unknown>>,
  ): void {
    this.setState({ type: "judging", done, total, judgingId, judgments });
  }

  setReport(judgments: Array<Record<string, unknown>>): void {
    this.setState({ type: "report", total: judgments.length, judgments });
  }

  fail(message: string): void {
    this.setState({ type: "error", message });
  }

  /** Returns the HTTP status the /ack route should respond with. */
  ack(): number {
    if (this.state.type !== "report") return 409;
    this.resolveAck();
    return 200;
  }

  attach(res: ServerResponse): void {
    this.clients.add(res);
    res.write(this.snapshotFrame());
  }

  detach(res: ServerResponse): void {
    this.clients.delete(res);
  }

  closeClients(): void {
    for (const client of this.clients) client.end();
    this.clients.clear();
  }

  private setState(state: ReportState): void {
    this.state = state;
    this.revision += 1;
    const frame = this.snapshotFrame();
    for (const client of this.clients) client.write(frame);
  }

  private snapshotFrame(): string {
    const snapshot = { revision: this.revision, behavior: this.behavior, state: this.state };
    return `data: ${JSON.stringify(snapshot)}\n\n`;
  }
}

function tokenMatches(provided: string | null, token: string): boolean {
  if (provided === null) return false;
  const providedBuffer = Buffer.from(provided);
  const tokenBuffer = Buffer.from(token);
  return (
    providedBuffer.length === tokenBuffer.length && timingSafeEqual(providedBuffer, tokenBuffer)
  );
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  session: WebReportSession,
): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }
  if (!tokenMatches(url.searchParams.get("token"), token)) {
    res.writeHead(403, { "content-type": "text/plain" }).end("Forbidden");
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(REPORT_PAGE_HTML);
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    session.attach(res);
    const ping = setInterval(() => {
      res.write(": ping\n\n");
    }, 15000);
    ping.unref();
    req.on("close", () => {
      clearInterval(ping);
      session.detach(res);
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/ack") {
    const status = session.ack();
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: status === 200 }));
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
}

/**
 * Judge every case while a browser page watches progress, and resolve with
 * the judgments once the rendered report has been acknowledged by the page.
 */
export async function runWebReport(options: WebReportOptions): Promise<TrajectoryJudgment[]> {
  const token = randomBytes(16).toString("hex");
  const session = new WebReportSession(options.ir.behavior);
  const server = createServer((req, res) => {
    handleRequest(req, res, token, session);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/?token=${token}`;
  options.log(`Report running at ${url}`);
  options.log("The CLI exits once the report has loaded in your browser; Ctrl-C aborts.");
  options.openBrowser?.(url);

  try {
    const irByName = new Map(options.ir.metaBehaviors.map((meta) => [meta.name, meta]));
    const judgments: TrajectoryJudgment[] = [];
    const payloads: Array<Record<string, unknown>> = [];
    for (const [index, trajectoryCase] of options.cases.entries()) {
      session.setJudging(index, options.cases.length, trajectoryCase.trajectory.id, [...payloads]);
      const judgment = await options.judgeCase(trajectoryCase, index);
      judgments.push(judgment);
      payloads.push(judgmentPayload(judgment, trajectoryCase.trajectory, irByName));
    }
    session.setReport(payloads);
    await session.acked;
    return judgments;
  } catch (error) {
    session.fail(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    session.closeClients();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      // Keep-alive sockets from ack posts would otherwise stall close().
      server.closeAllConnections();
    });
  }
}
