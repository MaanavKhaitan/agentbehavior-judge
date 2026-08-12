import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  prepareInterview,
  renderNote,
  runProposalInterview,
  type CheckAnswer,
  type CheckStep,
  type ConfirmStep,
  type EvidenceSample,
  type InterviewInput,
  type InterviewPresenter,
  type NameAnswer,
  type NameStep,
  type PatternEvidence,
  type SemanticCheckAnswer,
  type SemanticCheckStep,
  type TriggerAnswer,
  type TriggerStep,
} from "./generate.js";
import type { JudgeCompletion } from "./gateway.js";
import type { JudgeIr } from "./ir.js";
import { INTERVIEW_PAGE_HTML } from "./webInterviewPage.js";

/**
 * Browser presentation of the generate interview (`generate --web`).
 *
 * The interview driver in generate.ts stays the single source of truth; this
 * module is one more InterviewPresenter: steps stream to the page over SSE,
 * answers come back as JSON posts. Back-navigation exploits the driver being
 * deterministic given (proposal, answers): pop the last recorded answer,
 * restart the driver, and replay the rest — the model is never re-asked.
 *
 * The server binds 127.0.0.1 on a random port and every route requires the
 * one-time token embedded in the printed URL, so other local processes (or
 * web pages poking at localhost) cannot answer the interview.
 */

export interface WebInterviewOptions {
  input: InterviewInput;
  complete: JudgeCompletion;
  /** Where the IR will be written on confirm; shown in the UI. */
  outPath: string;
  /** Writes the confirmed IR and returns the path it was written to. */
  writeIr: (ir: JudgeIr) => Promise<string>;
  /** Terminal progress lines (URL, vocabulary notes, drops). */
  log: (line: string) => void;
  openBrowser?: (url: string) => void;
  /** Defaults to 0 (a random free port). */
  port?: number;
}

type AnyStep = NameStep | TriggerStep | CheckStep | SemanticCheckStep | ConfirmStep;

type ConfirmAnswer = { kind: "save" } | { kind: "cancel" };

type StepAnswer = NameAnswer | TriggerAnswer | CheckAnswer | SemanticCheckAnswer | ConfirmAnswer;

type SessionState =
  | { type: "loading" }
  | { type: "step"; stepId: number; canGoBack: boolean; step: Record<string, unknown> }
  | { type: "done"; written: string | null }
  | { type: "error"; message: string };

/** Thrown into the pending presenter promise to unwind a run for replay. */
class RestartSignal extends Error {
  constructor() {
    super("web interview restarting after back-navigation");
  }
}

interface PendingStep {
  index: number;
  step: AnyStep;
  resolve: (answer: StepAnswer) => void;
  reject: (error: Error) => void;
}

const MAX_TEXT_ANSWER = 4000;
const MAX_BODY_BYTES = 65536;
const EVIDENCE_CONTENT_MAX = 200;

function clip(content: string, max: number): string {
  const flat = content.replaceAll(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function samplePayload(sample: EvidenceSample): Record<string, unknown> {
  const metadata: Record<string, string> = {};
  for (const key of Object.keys(sample.matcher.metadata ?? {})) {
    metadata[key] = sample.event.metadata?.[key] ?? "";
  }
  return {
    actor: sample.event.actor,
    action: sample.event.action,
    content: clip(sample.event.content, EVIDENCE_CONTENT_MAX),
    metadata,
  };
}

function evidencePayload(entry: PatternEvidence): Record<string, unknown> {
  return {
    role: entry.role,
    noMatchIsExpected: entry.noMatchIsExpected,
    sample: entry.sample === undefined ? null : samplePayload(entry.sample),
  };
}

const SUMMARY_TEXT_MAX = 120;

function confirmSummary(ir: JudgeIr): Array<Record<string, unknown>> {
  return ir.metaBehaviors.map((meta) => ({
    name: meta.name,
    semanticTrigger: !("match" in meta.trigger),
    triggerDescription: clip(meta.trigger.description, SUMMARY_TEXT_MAX),
    checkCount: meta.checks.length,
    semanticCheckCount: meta.semanticChecks.length,
    checks: meta.checks.map((check) => ({
      type: check.type,
      quote: clip(check.quote, SUMMARY_TEXT_MAX),
    })),
    semanticChecks: meta.semanticChecks.map((check) => ({
      question: clip(check.question, SUMMARY_TEXT_MAX),
    })),
  }));
}

function stepPayload(step: AnyStep, outPath: string): Record<string, unknown> {
  switch (step.kind) {
    case "name":
      return { kind: "name", name: step.name, index: step.index, count: step.count };
    case "trigger":
      return {
        kind: "trigger",
        metaName: step.metaName,
        description: step.trigger.description,
        semantic: !("match" in step.trigger),
        match: "match" in step.trigger ? step.trigger.match : null,
        evidence: step.evidence === undefined ? null : evidencePayload(step.evidence),
        unobserved: step.unobserved,
        position: step.position,
      };
    case "check":
      return {
        kind: "check",
        metaName: step.metaName,
        check: step.check,
        evidence: step.evidence.map(evidencePayload),
        unobserved: step.unobserved,
        position: step.position,
      };
    case "semanticCheck":
      return {
        kind: "semanticCheck",
        metaName: step.metaName,
        quote: step.check.quote,
        question: step.check.question,
        demoted: step.demoted,
        position: step.position,
      };
    case "confirm":
      return { kind: "confirm", yaml: step.yaml, outPath, summary: confirmSummary(step.ir) };
  }
}

function textField(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= MAX_TEXT_ANSWER ? value : undefined;
}

/** Validates a browser-supplied answer against the step it claims to answer. */
function parseAnswer(step: AnyStep, raw: unknown): StepAnswer | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const kind = record.kind;

  if (step.kind === "name") {
    if (kind === "keep" || kind === "drop") return { kind };
    if (kind === "rename") {
      const name = textField(record.name);
      return name === undefined ? undefined : { kind: "rename", name };
    }
    return undefined;
  }
  if (step.kind === "trigger") {
    if (kind === "accept") return { kind };
    if (kind === "forceSemantic" && "match" in step.trigger) return { kind };
    if (kind === "edit") {
      const description = textField(record.description);
      return description === undefined ? undefined : { kind: "edit", description };
    }
    return undefined;
  }
  if (step.kind === "check") {
    if (kind === "accept" || kind === "demote" || kind === "drop") return { kind };
    return undefined;
  }
  if (step.kind === "semanticCheck") {
    if (kind === "accept" || kind === "drop") return { kind };
    if (kind === "edit") {
      const question = textField(record.question);
      return question === undefined ? undefined : { kind: "edit", question };
    }
    return undefined;
  }
  if (kind === "save" || kind === "cancel") return { kind };
  return undefined;
}

class WebInterviewSession {
  private readonly recorded: StepAnswer[] = [];
  private cursor = 0;
  private pending: PendingStep | undefined;
  private revision = 0;
  private state: SessionState = { type: "loading" };
  private readonly clients = new Set<ServerResponse>();

  constructor(
    private readonly behavior: string,
    private readonly outPath: string,
    private readonly log: (line: string) => void,
  ) {}

  // The recorded answers are replayed positionally: the driver is
  // deterministic given (proposal, answers), so answer N always lands on the
  // same step N — which is what makes the per-method casts sound.
  readonly presenter: InterviewPresenter = {
    note: (note) => {
      // Markdown-style rule headers are terminal presentation; the browser
      // shows the rule name on the card itself.
      if (note.kind === "metaHeader") return;
      // Replayed runs re-emit earlier notes; only log at the live frontier.
      if (this.cursor === this.recorded.length) this.log(renderNote(note));
    },
    askName: (step) => this.present(step) as Promise<NameAnswer>,
    askTrigger: (step) => this.present(step) as Promise<TriggerAnswer>,
    askCheck: (step) => this.present(step) as Promise<CheckAnswer>,
    askSemanticCheck: (step) => this.present(step) as Promise<SemanticCheckAnswer>,
    confirm: async (step) => {
      const answer = (await this.present(step)) as ConfirmAnswer;
      return answer.kind === "save";
    },
  };

  /** Reset replay position before each driver run. */
  beginRun(): void {
    this.cursor = 0;
    this.pending = undefined;
  }

  private present(step: AnyStep): Promise<StepAnswer> {
    const index = this.cursor;
    if (index < this.recorded.length) {
      this.cursor += 1;
      return Promise.resolve(this.recorded[index]!);
    }
    this.setState({
      type: "step",
      stepId: index,
      canGoBack: index > 0,
      step: stepPayload(step, this.outPath),
    });
    return new Promise((resolve, reject) => {
      this.pending = { index, step, resolve, reject };
    });
  }

  /** Returns the HTTP status the /answer route should respond with. */
  answer(stepId: unknown, raw: unknown): number {
    const pending = this.pending;
    if (pending === undefined || stepId !== pending.index) return 409;
    const parsed = parseAnswer(pending.step, raw);
    if (parsed === undefined) return 400;
    this.pending = undefined;
    this.recorded.push(parsed);
    this.cursor = this.recorded.length;
    pending.resolve(parsed);
    return 200;
  }

  /** Returns the HTTP status the /back route should respond with. */
  back(): number {
    const pending = this.pending;
    if (pending === undefined || this.recorded.length === 0) return 409;
    this.recorded.pop();
    this.pending = undefined;
    pending.reject(new RestartSignal());
    return 200;
  }

  finish(written: string | null): void {
    this.setState({ type: "done", written });
  }

  fail(message: string): void {
    this.setState({ type: "error", message });
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

  private setState(state: SessionState): void {
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

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (body.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    req.on("error", reject);
  });
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  session: WebInterviewSession,
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
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(INTERVIEW_PAGE_HTML);
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

  if (req.method === "POST" && (url.pathname === "/answer" || url.pathname === "/back")) {
    readJsonBody(req).then(
      (body) => {
        let status: number;
        if (url.pathname === "/back") {
          status = session.back();
        } else {
          const record =
            body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
          status = session.answer(record.stepId, record.answer);
        }
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: status === 200 }));
      },
      () => {
        res
          .writeHead(400, { "content-type": "application/json" })
          .end(JSON.stringify({ ok: false }));
      },
    );
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
}

/**
 * Serve the interview to a browser and resolve with the confirmed IR
 * (undefined when the user cancels). `writeIr` runs before the success screen
 * is shown, so the page never claims a file exists that was not written.
 */
export async function runWebInterview(options: WebInterviewOptions): Promise<JudgeIr | undefined> {
  const token = randomBytes(16).toString("hex");
  const session = new WebInterviewSession(options.input.behaviorName, options.outPath, options.log);
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
  options.log(`Interview running at ${url}`);
  options.log("Answer it in your browser; Ctrl-C here aborts without writing.");
  options.openBrowser?.(url);

  try {
    const prepared = await prepareInterview(options.input, options.complete, (note) => {
      options.log(renderNote(note));
    });
    for (;;) {
      session.beginRun();
      try {
        const ir = await runProposalInterview(
          prepared.proposal,
          prepared.context,
          session.presenter,
        );
        if (ir === undefined) {
          session.finish(null);
          return undefined;
        }
        const written = await options.writeIr(ir);
        session.finish(written);
        return ir;
      } catch (error) {
        if (error instanceof RestartSignal) continue;
        throw error;
      }
    }
  } catch (error) {
    session.fail(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    session.closeClients();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      // Keep-alive sockets from answer posts would otherwise stall close().
      server.closeAllConnections();
    });
  }
}
