import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { ProjectSessionSummaryWindow, ProjectSessionSummaryWindowInput } from "./types";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("./renderer-command", () => ({ invokeRendererQuery: invokeMock }));

import { readSessionSummaryLane } from "./session-summary-lanes";

const windowFor = (input: ProjectSessionSummaryWindowInput): ProjectSessionSummaryWindow => ({
  items: [],
  totalCount: 0,
  nextCursor: null,
  hasMore: false,
  projectionRevision: input.first ?? 0,
});

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(
    async (
      channel: string,
      _projectId: string | null,
      input: ProjectSessionSummaryWindowInput | readonly ProjectSessionSummaryWindowInput[],
    ) =>
      channel === "workspace:tasks:lanes"
        ? (input as readonly ProjectSessionSummaryWindowInput[]).map(windowFor)
        : windowFor(input as ProjectSessionSummaryWindowInput),
  );
});

test("reads lanes asked for together per scope, at most four to a request", async () => {
  const windows = await Promise.all([
    ...[1, 2, 3, 4, 5].map((first) => readSessionSummaryLane("alpha", { first })),
    readSessionSummaryLane(null, { first: 6 }),
  ]);

  expect(windows.map((window) => window.projectionRevision)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(invokeMock.mock.calls).toEqual([
    ["workspace:tasks:lanes", "alpha", [{ first: 1 }, { first: 2 }, { first: 3 }, { first: 4 }]],
    ["workspace:tasks:list", "alpha", { first: 5 }],
    ["workspace:tasks:list", null, { first: 6 }],
  ]);
});

test("fails every lane of a failed request and reads afresh next time", async () => {
  invokeMock.mockRejectedValueOnce(new Error("Core is unavailable"));
  const failed = await Promise.allSettled([
    readSessionSummaryLane("alpha", { first: 1 }),
    readSessionSummaryLane("alpha", { first: 2 }),
  ]);
  expect(failed.map((result) => result.status)).toEqual(["rejected", "rejected"]);

  await expect(readSessionSummaryLane("alpha", { first: 3 })).resolves.toMatchObject({
    projectionRevision: 3,
  });
  expect(invokeMock).toHaveBeenCalledTimes(2);
});
