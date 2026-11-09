import { parsePageTurn, type PageTurn } from "./page-turn";
import type { components } from "@nodex/core-protocol";

export type PageWork = components["schemas"]["PageWork"];
export type PageAssignee = components["schemas"]["PageAssignee"];
export type Member = components["schemas"]["Member"];
export type AgentSelection = components["schemas"]["AgentWorkSelection"];
export type WorkPage = {
  readonly pageId: string;
  readonly pageKey: string | null;
  readonly title: string;
  readonly status: string | null;
};
export interface PrerequisitesSummary {
  readonly unsatisfiedCount: number;
  readonly blockers: readonly WorkPage[];
}
export interface WorkSummary extends PrerequisitesSummary {
  readonly turn?: PageTurn | null;
  readonly pullRequest?: { readonly number: number; readonly url: string; readonly state: string };
  readonly owner: string | null;
  readonly assignee: PageAssignee | null;
  readonly autoStart: boolean;
}
export interface ReadyWorkPage {
  readonly pageId: string;
  readonly projectId: string;
  readonly pageWork: PageWork;
  readonly prerequisites: readonly {
    readonly pageId: string;
    readonly satisfied: boolean;
    readonly satisfyingRevision: string | null;
  }[];
  readonly readinessEpoch: string;
}
export interface BlockingWindow {
  readonly pages: readonly WorkPage[];
  readonly nextCursor: string | null;
  readonly projectionRevision: number;
}

const record = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new TypeError("Work graph value must be an object");
};
const exact = (value: Record<string, unknown>, keys: readonly string[]) => {
  if (Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)))
    return;
  throw new TypeError(`Work graph value requires exactly ${keys.join(", ")}`);
};
const text = (value: unknown, max = 512): string => {
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !/\p{Cc}/u.test(value) &&
    new TextEncoder().encode(value).length <= max
  )
    return value;
  throw new TypeError("Work graph value must be a canonical bounded string");
};
const nullableText = (value: unknown, max = 512): string | null =>
  value === null ? null : text(value, max);
const count = (value: unknown): number => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw new TypeError("Work graph count must be a nonnegative integer");
};

/** Validates the exact Page-owned assignment grammar at transport boundaries. */
export const parsePageAssignee = (value: unknown): PageAssignee | null => {
  if (value === null) return null;
  const assignment = record(value);
  if (assignment.kind === "member") {
    exact(assignment, ["kind", "member_id"]);
    return { kind: "member", member_id: text(assignment.member_id) };
  }
  if (assignment.kind !== "agent") throw new TypeError("Assignee must be a Member or an Agent");
  exact(
    assignment,
    Object.hasOwn(assignment, "effort")
      ? ["kind", "instance_id", "model", "effort"]
      : ["kind", "instance_id", "model"],
  );
  return {
    kind: "agent",
    instance_id: text(assignment.instance_id),
    model: text(assignment.model),
    effort: assignment.effort == null ? null : text(assignment.effort, 128),
  };
};
export const agentSelectionOf = (
  assignee: PageAssignee | null | undefined,
): AgentSelection | null =>
  assignee?.kind === "agent"
    ? { instanceId: assignee.instance_id, model: assignee.model, effort: assignee.effort ?? null }
    : null;
export const parsePageWork = (value: unknown): PageWork | null => {
  if (value === null) return null;
  const work = record(value);
  exact(work, ["owner", "assignee", "auto_start"]);
  const assignee = parsePageAssignee(work.assignee);
  if (typeof work.auto_start !== "boolean" || (work.auto_start && assignee?.kind !== "agent"))
    throw new TypeError("Automatic start requires an Agent Assignee");
  return { owner: text(work.owner), assignee, auto_start: work.auto_start };
};
export const parseWorkPage = (value: unknown): WorkPage => {
  const page = record(value);
  exact(page, ["pageId", "pageKey", "title", "status"]);
  if (typeof page.title !== "string" || new TextEncoder().encode(page.title).byteLength > 2048)
    throw new TypeError("Work Page title must be bounded");
  return {
    pageId: text(page.pageId),
    pageKey: nullableText(page.pageKey),
    title: page.title,
    status: nullableText(page.status),
  };
};
export const parsePrerequisitesSummary = (value: unknown): PrerequisitesSummary => {
  const summary = record(value);
  exact(summary, ["unsatisfiedCount", "blockers"]);
  if (!Array.isArray(summary.blockers) || summary.blockers.length > 3)
    throw new TypeError("Prerequisites preview must contain at most three blockers");
  const unsatisfiedCount = count(summary.unsatisfiedCount);
  if (summary.blockers.length > unsatisfiedCount)
    throw new TypeError("Prerequisites preview exceeds its count");
  return { unsatisfiedCount, blockers: summary.blockers.map(parseWorkPage) };
};
export const parseWorkSummary = (value: unknown): WorkSummary => {
  const summary = record(value);
  exact(summary, [
    "unsatisfiedCount",
    "blockers",
    "owner",
    "assignee",
    "autoStart",
    ...(Object.hasOwn(summary, "turn") ? ["turn"] : []),
    ...(Object.hasOwn(summary, "pullRequest") ? ["pullRequest"] : []),
  ]);
  const prerequisites = parsePrerequisitesSummary({
    unsatisfiedCount: summary.unsatisfiedCount,
    blockers: summary.blockers,
  });
  const assignee = parsePageAssignee(summary.assignee);
  if (typeof summary.autoStart !== "boolean" || (summary.autoStart && assignee?.kind !== "agent"))
    throw new TypeError("Invalid automatic start consent");
  const pr = summary.pullRequest === undefined ? null : record(summary.pullRequest);
  if (
    pr &&
    (!Number.isInteger(pr.number) ||
      Number(pr.number) < 1 ||
      !["OPEN", "CLOSED", "MERGED"].includes(String(pr.state)))
  )
    throw new TypeError("Invalid Page pull request");
  return {
    ...prerequisites,
    ...(summary.turn ? { turn: parsePageTurn(summary.turn) } : {}),
    owner: nullableText(summary.owner),
    assignee,
    autoStart: summary.autoStart,
    ...(pr
      ? {
          pullRequest: {
            number: Number(pr.number),
            url: text(pr.url, 2048),
            state: String(pr.state),
          },
        }
      : {}),
  };
};
export const parseReadyWorkPages = (value: unknown): readonly ReadyWorkPage[] => {
  if (!Array.isArray(value) || value.length > 100)
    throw new TypeError("Ready work must contain at most 100 Pages");
  return value.map((entry) => {
    const page = record(entry);
    exact(page, ["pageId", "projectId", "pageWork", "prerequisites", "readinessEpoch"]);
    const pageWork = parsePageWork(page.pageWork);
    if (!pageWork || pageWork.assignee?.kind !== "agent")
      throw new TypeError("Ready work requires its Agent work launch policy");
    if (!Array.isArray(page.prerequisites) || page.prerequisites.length > 10_000)
      throw new TypeError("Ready work prerequisites exceed their bound");
    const prerequisites = page.prerequisites.map((entry) => {
      const prerequisite = record(entry);
      exact(prerequisite, ["pageId", "satisfied", "satisfyingRevision"]);
      if (typeof prerequisite.satisfied !== "boolean")
        throw new TypeError("Prerequisite satisfaction must be boolean");
      return {
        pageId: text(prerequisite.pageId),
        satisfied: prerequisite.satisfied,
        satisfyingRevision: nullableText(prerequisite.satisfyingRevision, 1024),
      };
    });
    return {
      pageId: text(page.pageId),
      projectId: text(page.projectId),
      pageWork,
      prerequisites,
      readinessEpoch: text(page.readinessEpoch, 1024),
    };
  });
};
export const parseBlockingWindow = (value: unknown): BlockingWindow => {
  const window = record(value);
  exact(window, ["pages", "nextCursor", "projectionRevision"]);
  if (!Array.isArray(window.pages) || window.pages.length > 100)
    throw new TypeError("Blocking must contain at most 100 Pages");
  return {
    pages: window.pages.map(parseWorkPage),
    nextCursor: nullableText(window.nextCursor, 4096),
    projectionRevision: count(window.projectionRevision),
  };
};
export const projectCoreWorkPage = (page: components["schemas"]["DatabaseWorkPage"]): WorkPage => ({
  pageId: page.page_id,
  pageKey: page.page_key ?? null,
  title: page.title,
  status: page.status ?? null,
});
export const projectCorePrerequisites = (
  summary: components["schemas"]["DatabasePrerequisitesSummary"],
): PrerequisitesSummary => ({
  unsatisfiedCount: summary.unsatisfied_count,
  blockers: summary.blockers.map(projectCoreWorkPage),
});
export const projectCoreWorkSummary = (
  summary: components["schemas"]["DatabaseWorkSummary"],
): WorkSummary => ({
  ...projectCorePrerequisites(summary),
  turn: summary.turn ?? null,
  ...(summary.pull_request
    ? {
        pullRequest: {
          number: summary.pull_request.number,
          url: summary.pull_request.url,
          state: summary.pull_request.state,
        },
      }
    : {}),
  owner: summary.owner ?? null,
  assignee: summary.assignee ?? null,
  autoStart: summary.auto_start,
});

export const parseMember = (value: unknown): Member => {
  const member = record(value);
  exact(member, ["id", "library_id", "display_name", "lifecycle", "revision", "role"]);
  if (member.lifecycle !== "active" && member.lifecycle !== "removed")
    throw new TypeError("Invalid Member lifecycle");
  if (member.role !== "owner" && member.role !== "member")
    throw new TypeError("Invalid Member role");
  if (count(member.revision) < 1) throw new TypeError("Member revision must be positive");
  return {
    id: text(member.id),
    library_id: text(member.library_id),
    display_name: text(member.display_name, 1024),
    lifecycle: member.lifecycle,
    role: member.role,
    revision: count(member.revision),
  };
};

/** Mirrors Core consent revocation when an editor replaces an assignment. */
export const withPageAssignee = (work: PageWork, assignee: PageAssignee | null): PageWork => ({
  ...work,
  assignee,
  auto_start:
    assignee?.kind === "agent" &&
    work.assignee?.kind === "agent" &&
    pageAssigneeKey(assignee) === pageAssigneeKey(work.assignee)
      ? work.auto_start
      : false,
});

/** Stable presentation keys; persistent assignment still uses the typed reference. */
export const pageAssigneeKey = (assignee: PageAssignee): string =>
  JSON.stringify(
    assignee.kind === "member"
      ? { kind: "member", member_id: assignee.member_id }
      : {
          kind: "agent",
          instance_id: assignee.instance_id,
          model: assignee.model,
          effort: assignee.effort ?? null,
        },
  );
export const pageAssigneeFromKey = (key: string): PageAssignee | null => {
  try {
    return parsePageAssignee(JSON.parse(key));
  } catch {
    return null;
  }
};
export const pageAssigneeName = (
  assignee: PageAssignee | null | undefined,
  members: readonly Member[] = [],
): string => {
  if (!assignee) return "";
  if (assignee.kind === "agent") return `${assignee.instance_id} · ${assignee.model}`;
  return members.find((member) => member.id === assignee.member_id)?.display_name ?? "Member";
};

export const pageAssigneeGroupKey = (assignee: PageAssignee): string =>
  assignee.kind === "member"
    ? `member:${assignee.member_id}`
    : `agent:${JSON.stringify([assignee.instance_id, assignee.model])}`;
export const pageAssigneeFromGroupKey = (key: string | null): PageAssignee | null => {
  if (key?.startsWith("member:")) return { kind: "member", member_id: key.slice(7) };
  if (!key?.startsWith("agent:")) return null;
  try {
    const value: unknown = JSON.parse(key.slice(6));
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      value.some((part) => typeof part !== "string" || !part)
    )
      return null;
    return parsePageAssignee({ kind: "agent", instance_id: value[0], model: value[1] });
  } catch {
    return null;
  }
};
