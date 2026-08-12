import {
  prepareInterview,
  renderNote,
  runProposalInterview,
  type CheckAnswer,
  type CheckStep,
  type ConfirmStep,
  type EvidenceSample,
  type InterviewInput,
  type NameAnswer,
  type NameStep,
  type PatternEvidence,
  type SemanticCheckAnswer,
  type SemanticCheckStep,
  type TriggerAnswer,
  type TriggerStep,
} from "./generate.js";
import type { JudgeCompletion } from "./gateway.js";
import type { JudgeIr, Trigger } from "./ir.js";
import { clip } from "./text.js";
import {
  prepareUpdate,
  renderUpdateNote,
  runUpdateProposalInterview,
  type CarriedBatchAnswer,
  type CarriedBatchStep,
  type CarriedClause,
  type ChangedTriggerAnswer,
  type ChangedTriggerStep,
  type UpdateInput,
  type UpdatePresenter,
} from "./update.js";
import { INTERVIEW_PAGE_HTML } from "./webInterviewPage.js";
import { SnapshotSession, startWebServer } from "./webServer.js";

/**
 * Browser presentation of the generate and update interviews
 * (`generate --web`, optionally with `--update`).
 *
 * The interview drivers in generate.ts and update.ts stay the single source
 * of truth; this module is one more presenter: steps stream to the page over
 * SSE, answers come back as JSON posts. Back-navigation exploits the drivers
 * being deterministic given (prepared LLM results, answers): pop the last
 * recorded answer, restart the driver, and replay the rest — the model is
 * never re-asked.
 *
 * Server plumbing (127.0.0.1-only, one-time token on every route) lives in
 * webServer.ts, shared with the judge report server.
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

/** `generate --web --update`: the same server around the update driver. */
export interface WebUpdateInterviewOptions extends Omit<WebInterviewOptions, "input"> {
  input: UpdateInput;
}

type AnyStep =
  | NameStep
  | TriggerStep
  | CheckStep
  | SemanticCheckStep
  | ChangedTriggerStep
  | CarriedBatchStep
  | ConfirmStep;

type ConfirmAnswer = { kind: "save" } | { kind: "cancel" };

type StepAnswer =
  | NameAnswer
  | TriggerAnswer
  | CheckAnswer
  | SemanticCheckAnswer
  | ChangedTriggerAnswer
  | CarriedBatchAnswer
  | ConfirmAnswer;

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
const EVIDENCE_CONTENT_MAX = 200;

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

function triggerPayload(trigger: Trigger): Record<string, unknown> {
  return {
    description: trigger.description,
    semantic: !("match" in trigger),
    match: "match" in trigger ? trigger.match : null,
  };
}

function carriedClausePayload(clause: CarriedClause): Record<string, unknown> {
  if (clause.kind === "trigger") {
    return { kind: "trigger", trigger: triggerPayload(clause.trigger) };
  }
  if (clause.kind === "check") {
    return {
      kind: "check",
      type: clause.check.type,
      quote: clip(clause.check.quote, SUMMARY_TEXT_MAX),
    };
  }
  return {
    kind: "semantic",
    quote: clip(clause.check.quote, SUMMARY_TEXT_MAX),
    question: clip(clause.check.question, SUMMARY_TEXT_MAX),
  };
}

function confirmSummary(
  ir: JudgeIr,
  statuses?: Record<string, "unchanged" | "changed" | "added">,
): Array<Record<string, unknown>> {
  return ir.metaBehaviors.map((meta) => ({
    name: meta.name,
    status: statuses?.[meta.name] ?? null,
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

/** Change tallies for the update confirm card; null outside update mode. */
function updatePayload(update: ConfirmStep["update"]): Record<string, unknown> | null {
  if (update === undefined) return null;
  const classifications = Object.values(update.statuses);
  const count = (kind: "unchanged" | "changed" | "added") =>
    classifications.filter((entry) => entry === kind).length;
  const changed = count("changed");
  const added = count("added");
  return {
    unchanged: count("unchanged"),
    changed,
    added,
    removed: update.removed,
    hasChanges: changed + added + update.removed.length > 0,
  };
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
        reAskReason: step.reAskReason ?? null,
      };
    case "check":
      return {
        kind: "check",
        metaName: step.metaName,
        check: step.check,
        evidence: step.evidence.map(evidencePayload),
        unobserved: step.unobserved,
        position: step.position,
        reAskReason: step.reAskReason ?? null,
      };
    case "semanticCheck":
      return {
        kind: "semanticCheck",
        metaName: step.metaName,
        quote: step.check.quote,
        question: step.check.question,
        demoted: step.demoted,
        position: step.position,
        reAskReason: step.reAskReason ?? null,
      };
    case "changedTrigger":
      return {
        kind: "changedTrigger",
        metaName: step.metaName,
        previous: triggerPayload(step.previous),
        proposed: triggerPayload(step.proposed),
        evidence: step.evidence === undefined ? null : evidencePayload(step.evidence),
        unobserved: step.unobserved,
        position: step.position,
      };
    case "carriedBatch":
      return {
        kind: "carriedBatch",
        metaName: step.metaName,
        items: step.items.map(carriedClausePayload),
        position: step.position,
      };
    case "confirm":
      return {
        kind: "confirm",
        yaml: step.yaml,
        outPath,
        summary: confirmSummary(step.ir, step.update?.statuses),
        update: updatePayload(step.update),
      };
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
  if (step.kind === "changedTrigger") {
    if (kind === "accept" || kind === "keepPrevious" || kind === "forceSemantic") return { kind };
    if (kind === "edit") {
      const description = textField(record.description);
      return description === undefined ? undefined : { kind: "edit", description };
    }
    return undefined;
  }
  if (step.kind === "carriedBatch") {
    if (kind === "keep" || kind === "review") return { kind };
    return undefined;
  }
  if (kind === "save" || kind === "cancel") return { kind };
  return undefined;
}

class WebInterviewSession extends SnapshotSession<SessionState> {
  private readonly recorded: StepAnswer[] = [];
  private cursor = 0;
  private pending: PendingStep | undefined;
  private noteIndex = 0;
  private readonly loggedNotes: string[] = [];

  constructor(
    behavior: string,
    private readonly outPath: string,
    private readonly log: (line: string) => void,
  ) {
    super(behavior, { type: "loading" });
  }

  // The recorded answers are replayed positionally: the drivers are
  // deterministic given (prepared results, answers), so answer N always lands
  // on the same step N — which is what makes the per-method casts sound.
  readonly presenter: UpdatePresenter = {
    note: (note) => {
      // Markdown-style rule headers are terminal presentation; the browser
      // shows the rule name on the card itself.
      if (note.kind === "metaHeader") return;
      // Replayed runs re-emit earlier notes; the driver being deterministic
      // makes note N a function of the answers before it, so a note matching
      // the one already logged at this ordinal is a replay, not news. A
      // mismatch means the user answered differently after going back — log
      // it and drop the now-stale history behind it.
      const rendered = renderUpdateNote(note);
      const index = this.noteIndex;
      this.noteIndex += 1;
      if (this.loggedNotes[index] === rendered) return;
      this.loggedNotes.length = index;
      this.loggedNotes.push(rendered);
      this.log(rendered);
    },
    askName: (step) => this.present(step) as Promise<NameAnswer>,
    askTrigger: (step) => this.present(step) as Promise<TriggerAnswer>,
    askCheck: (step) => this.present(step) as Promise<CheckAnswer>,
    askSemanticCheck: (step) => this.present(step) as Promise<SemanticCheckAnswer>,
    askChangedTrigger: (step) => this.present(step) as Promise<ChangedTriggerAnswer>,
    askCarriedBatch: (step) => this.present(step) as Promise<CarriedBatchAnswer>,
    confirm: async (step) => {
      const answer = (await this.present(step)) as ConfirmAnswer;
      return answer.kind === "save";
    },
  };

  /** Reset replay position before each driver run. */
  beginRun(): void {
    this.cursor = 0;
    this.pending = undefined;
    this.noteIndex = 0;
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
}

interface ServeOptions<Prepared> {
  behaviorName: string;
  outPath: string;
  writeIr: (ir: JudgeIr) => Promise<string>;
  log: (line: string) => void;
  openBrowser: ((url: string) => void) | undefined;
  port: number | undefined;
  /** The LLM phase: runs once while the page shows the loading screen. */
  prepare: () => Promise<Prepared>;
  /** The deterministic phase: restarted from scratch on every back-navigation. */
  drive: (prepared: Prepared, presenter: UpdatePresenter) => Promise<JudgeIr | undefined>;
}

/**
 * Serve an interview to a browser and resolve with the confirmed IR
 * (undefined when the user cancels). `writeIr` runs before the success screen
 * is shown, so the page never claims a file exists that was not written.
 */
async function serveInterview<Prepared>(
  options: ServeOptions<Prepared>,
): Promise<JudgeIr | undefined> {
  const session = new WebInterviewSession(options.behaviorName, options.outPath, options.log);
  const server = await startWebServer({
    pageHtml: INTERVIEW_PAGE_HTML,
    session,
    post: {
      "/answer": (body) => {
        const record =
          body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
        return session.answer(record.stepId, record.answer);
      },
      "/back": () => session.back(),
    },
    port: options.port,
  });
  options.log(`Interview running at ${server.url}`);
  options.log("Answer it in your browser; Ctrl-C here aborts without writing.");
  options.openBrowser?.(server.url);

  try {
    const prepared = await options.prepare();
    for (;;) {
      session.beginRun();
      try {
        const ir = await options.drive(prepared, session.presenter);
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
    await server.close();
  }
}

/** Serve the generate interview (`generate --web`) to a browser. */
export async function runWebInterview(options: WebInterviewOptions): Promise<JudgeIr | undefined> {
  return serveInterview({
    behaviorName: options.input.behaviorName,
    outPath: options.outPath,
    writeIr: options.writeIr,
    log: options.log,
    openBrowser: options.openBrowser,
    port: options.port,
    prepare: () =>
      prepareInterview(options.input, options.complete, (note) => {
        options.log(renderNote(note));
      }),
    drive: (prepared, presenter) =>
      runProposalInterview(prepared.proposal, prepared.context, presenter),
  });
}

/** Serve the diff-scoped update interview (`generate --web --update`) to a browser. */
export async function runWebUpdateInterview(
  options: WebUpdateInterviewOptions,
): Promise<JudgeIr | undefined> {
  return serveInterview({
    behaviorName: options.input.behaviorName,
    outPath: options.outPath,
    writeIr: options.writeIr,
    log: options.log,
    openBrowser: options.openBrowser,
    port: options.port,
    prepare: () =>
      prepareUpdate(options.input, options.complete, (note) => {
        options.log(renderUpdateNote(note));
      }),
    drive: (prepared, presenter) => runUpdateProposalInterview(prepared, presenter),
  });
}
