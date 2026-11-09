import type { components } from "@nodex/core-protocol";

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
}
export interface ReadyWorkPage {
  readonly pageId: string;
  readonly projectId: string;
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

  if (value === null) return null;
  return {
  };
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
  const prerequisites = parsePrerequisitesSummary({
    unsatisfiedCount: summary.unsatisfiedCount,
    blockers: summary.blockers,
  });
};
export const parseReadyWorkPages = (value: unknown): readonly ReadyWorkPage[] => {
  if (!Array.isArray(value) || value.length > 100)
    throw new TypeError("Ready work must contain at most 100 Pages");
  return value.map((entry) => {
    const page = record(entry);
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
});
