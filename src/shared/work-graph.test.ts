import { expect, test } from "vite-plus/test";
import {
  agentSelectionOf,
  parsePageAssignee,
  parsePageWork,
  pageAssigneeGroupKey,
  pageAssigneeFromGroupKey,
  withPageAssignee,
  parsePrerequisitesSummary,
  parseWorkSummary,
} from "./work-graph";
import { bindLibraryDatabaseModuleReadV2 } from "./database-module-v2-transport";
const agent = { kind: "agent", instance_id: "codex", model: "model", effort: null } as const;
const work = { owner: "person", assignee: agent, auto_start: false };
test("reselecting the same Agent preserves consent while reassignment revokes it", () => {
  const automatic = { ...work, auto_start: true };
  expect(withPageAssignee(automatic, { ...agent })).toEqual(automatic);
  for (const assignment of [
    null,
    { kind: "member", member_id: "person" } as const,
    { ...agent, model: "other" },
    { ...agent, effort: "high" },
  ]) {
    expect(withPageAssignee(automatic, assignment).auto_start).toBe(false);
  }
});
test("Agent groups preserve provider and model identity while combining effort choices", () => {
  const assigned = { ...agent, instance_id: "codex:personal", model: "provider/model" };
  const group = pageAssigneeGroupKey(assigned);
  expect(pageAssigneeGroupKey({ ...assigned, effort: "high" })).toBe(group);
  expect(pageAssigneeGroupKey({ ...assigned, instance_id: "codex:work" })).not.toBe(group);
  expect(pageAssigneeFromGroupKey(group)).toEqual({ ...assigned, effort: null });
});
test("Page work preserves typed people and Agents and bounds execution strings", () => {
  expect(parsePageWork(work)).toEqual(work);
  expect(parsePageAssignee({ kind: "member", member_id: "person" })).toEqual({
    kind: "member",
    member_id: "person",
  });
  expect(agentSelectionOf(agent)).toEqual({ instanceId: "codex", model: "model", effort: null });
  expect(agentSelectionOf({ kind: "member", member_id: "person" })).toBeNull();
  for (const invalid of [
    { ...work, owner: "" },
    { ...work, extra: true },
    { ...work, assignee: { ...agent, model: "猫".repeat(171) } },
    { ...work, assignee: { ...agent, effort: "x".repeat(129) } },
    { ...work, assignee: { kind: "member", member_id: "person" }, auto_start: true },
  ])
    expect(() => parsePageWork(invalid)).toThrow();
});
test("row work requires consent to belong to an Agent and bounds prerequisite previews", () => {
  const summary = {
    unsatisfiedCount: 0,
    blockers: [],
    owner: "person",
    assignee: agent,
    autoStart: true,
  };
  expect(parseWorkSummary(summary)).toEqual(summary);
  const pullRequest = { number: 42, url: "https://github.com/acme/repo/pull/42", state: "OPEN" };
  expect(parseWorkSummary({ ...summary, pullRequest })).toEqual({ ...summary, pullRequest });
  expect(() => parseWorkSummary({ ...summary, assignee: null })).toThrow();
  expect(() =>
    parsePrerequisitesSummary({
      unsatisfiedCount: 1,
      blockers: [
        { pageId: "a", pageKey: null, title: "A", status: null },
        { pageId: "b", pageKey: null, title: "B", status: null },
      ],
    }),
  ).toThrow();
});
test("work graph reads preserve scoped coordinates and bounded windows", () => {
  expect(
    bindLibraryDatabaseModuleReadV2({
      read: { target: { kind: "page", pageId: "page:a" }, mode: "blocking", window: { first: 1 } },
    }).read,
  ).toMatchObject({ mode: "blocking", target: { pageId: "page:a" }, window: { first: 1 } });
  expect(() =>
    bindLibraryDatabaseModuleReadV2({
      read: { target: { kind: "library" }, mode: "ready_work", limit: 101 },
    }),
  ).toThrow();
});
