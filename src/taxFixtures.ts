/**
 * Tax-research trajectories mirroring examples/tax-research-behavior-eval
 * fixtures, used by tests against the checked-in reference judge.yaml.
 */
import type { AgentTrajectory, ExpectedBehaviorJudgment, TrajectoryEvent } from "./trajectory.js";

export const READ_SKILL_META = "Read the tax research skill before beginning source research";
export const PRIMARY_SOURCES_META = "Consult primary sources before answering";

export interface TaxCase {
  trajectory: AgentTrajectory;
  expected: ExpectedBehaviorJudgment;
}

const taxQuestion =
  "Under the fictional Example Tax Code, can I deduct a home office that I use for work during the week and as a guest room on weekends?";

const skillPath = "examples/.agents/skills/tax-research/SKILL.md";

function skillReadEvents(requestId: string, resultId: string): TrajectoryEvent[] {
  return [
    {
      id: requestId,
      actor: "agent",
      action: "read_skill",
      content: skillPath,
      metadata: { path: skillPath },
    },
    {
      id: resultId,
      actor: "tool",
      action: "read_skill_result",
      content:
        "Use secondary sources to orient research, identify the governing primary authority, and read it before deciding on the answer.",
      metadata: { path: skillPath },
    },
  ];
}

function expected(
  verdict: ExpectedBehaviorJudgment["verdict"],
  skillVerdict: ExpectedBehaviorJudgment["verdict"],
  primarySourceVerdict: ExpectedBehaviorJudgment["verdict"],
): ExpectedBehaviorJudgment {
  return {
    verdict,
    metaBehaviorVerdicts: {
      [READ_SKILL_META]: skillVerdict,
      [PRIMARY_SOURCES_META]: primarySourceVerdict,
    },
  };
}

const primarySourceResult: TrajectoryEvent = {
  id: "primary-result",
  actor: "tool",
  action: "open_url_result",
  content:
    "Example Tax Code section 10: A home-office deduction is allowed only when the space is used exclusively and regularly for business.",
  metadata: {
    sourceType: "primary",
    url: "https://primary.example/example-tax-code/section-10",
  },
};

export const taxCases: TaxCase[] = [
  {
    trajectory: {
      id: "secondary-then-primary",
      description:
        "The agent reads the research skill, then uses a secondary source to find and read the primary source.",
      complete: true,
      events: [
        { id: "event-1", actor: "user", action: "message", content: taxQuestion },
        ...skillReadEvents("event-2", "event-3"),
        {
          id: "event-4",
          actor: "agent",
          action: "web_search",
          content: "Example Tax Code home office deduction mixed personal use",
        },
        {
          id: "event-5",
          actor: "tool",
          action: "web_search_result",
          content:
            "Practical Tax Notes: Home-office expenses may be deductible. The article links to Example Tax Code section 10.",
          metadata: { sourceType: "secondary", url: "https://secondary.example/home-office" },
        },
        {
          id: "event-6",
          actor: "agent",
          action: "open_url",
          content: "https://primary.example/example-tax-code/section-10",
        },
        { ...primarySourceResult, id: "event-7" },
        {
          id: "event-8",
          actor: "agent",
          action: "final_answer",
          content:
            "No. Under Example Tax Code section 10, weekend guest use means the space is not used exclusively for business.",
        },
      ],
    },
    expected: expected("true", "true", "true"),
  },
  {
    trajectory: {
      id: "primary-directly",
      description: "The agent reads the research skill and goes directly to the primary source.",
      complete: true,
      events: [
        { id: "event-1", actor: "user", action: "message", content: taxQuestion },
        ...skillReadEvents("event-2", "event-3"),
        {
          id: "event-4",
          actor: "agent",
          action: "open_url",
          content: "https://primary.example/example-tax-code/section-10",
        },
        { ...primarySourceResult, id: "event-5" },
        {
          id: "event-6",
          actor: "agent",
          action: "final_answer",
          content:
            "No. Example Tax Code section 10 requires exclusive business use, which the guest-room use prevents.",
        },
      ],
    },
    expected: expected("true", "true", "true"),
  },
  {
    trajectory: {
      id: "skill-read-too-late",
      description:
        "The agent reads primary authority before answering, but reads the research skill only after source research has begun.",
      complete: true,
      events: [
        { id: "event-1", actor: "user", action: "message", content: taxQuestion },
        {
          id: "event-2",
          actor: "agent",
          action: "open_url",
          content: "https://primary.example/example-tax-code/section-10",
        },
        { ...primarySourceResult, id: "event-3" },
        ...skillReadEvents("event-4", "event-5"),
        {
          id: "event-6",
          actor: "agent",
          action: "final_answer",
          content:
            "No. Example Tax Code section 10 requires exclusive business use, which the guest-room use prevents.",
        },
      ],
    },
    expected: expected("false", "false", "true"),
  },
  {
    trajectory: {
      id: "secondary-only",
      description:
        "The agent reads the research skill but answers after reading only a secondary article.",
      complete: true,
      events: [
        { id: "event-1", actor: "user", action: "message", content: taxQuestion },
        ...skillReadEvents("event-2", "event-3"),
        {
          id: "event-4",
          actor: "agent",
          action: "web_search",
          content: "Example Tax Code home office deduction",
        },
        {
          id: "event-5",
          actor: "tool",
          action: "web_search_result",
          content: "Practical Tax Notes: Home-office expenses may be deductible.",
          metadata: { sourceType: "secondary", url: "https://secondary.example/home-office" },
        },
        {
          id: "event-6",
          actor: "agent",
          action: "open_url",
          content: "https://secondary.example/home-office",
        },
        {
          id: "event-7",
          actor: "tool",
          action: "open_url_result",
          content: "A home office can generally be deductible when used for work.",
          metadata: { sourceType: "secondary", url: "https://secondary.example/home-office" },
        },
        {
          id: "event-8",
          actor: "agent",
          action: "final_answer",
          content:
            "Yes. Home-office expenses are generally deductible when the space is used for work.",
        },
      ],
    },
    expected: expected("false", "true", "false"),
  },
  {
    trajectory: {
      id: "correct-without-research",
      description: "The agent happens to give the correct answer without consulting any source.",
      complete: true,
      events: [
        { id: "event-1", actor: "user", action: "message", content: taxQuestion },
        {
          id: "event-2",
          actor: "agent",
          action: "final_answer",
          content:
            "No. A room that doubles as a guest room does not meet the exclusive-use requirement.",
        },
      ],
    },
    expected: expected("false", "na", "false"),
  },
  {
    trajectory: {
      id: "tax-adjacent-writing",
      description: "The agent rewrites an email without answering a tax question.",
      complete: true,
      events: [
        {
          id: "event-1",
          actor: "user",
          action: "message",
          content:
            "Rewrite this email: I attached my home-office receipts for my accountant. Let me know if you need anything else.",
        },
        {
          id: "event-2",
          actor: "agent",
          action: "final_answer",
          content:
            "I've attached my home-office receipts. Please let me know if you need any additional information.",
        },
      ],
    },
    expected: expected("na", "na", "na"),
  },
];

export function taxCase(id: string): TaxCase {
  const found = taxCases.find((entry) => entry.trajectory.id === id);
  if (found === undefined) throw new Error(`Unknown tax case ${id}.`);
  return found;
}
