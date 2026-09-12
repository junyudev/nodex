import { expect, test } from "vite-plus/test";
import type { Thread, TurnEnvironmentParams } from "@nodex/codex-app-server-protocol/v2";
import { buildAgentActivityV2CorpusThread } from "./test-fixtures/agent-activity-v2-corpus-provenance";
import {
  acceptCodexPreparedEnvironmentSelection,
  mergeCodexThreadEnvironmentSelection,
  resolveCodexAcceptedThreadEnvironmentSelection,
} from "./codex-environment-selection";

const environment = (environmentId: string, cwd: string): TurnEnvironmentParams => ({
  environmentId,
  cwd,
  runtimeWorkspaceRoots: [cwd],
});

const threadWithEnvironment = (
  environmentValue: TurnEnvironmentParams,
  updatedAt: number,
): Thread =>
  ({
    ...buildAgentActivityV2CorpusThread([]),
    updatedAt,
    environments: [environmentValue],
  }) as Thread;

test("stored environment metadata cannot overwrite a live selection", () => {
  const live = environment("live", "/live");
  const result = mergeCodexThreadEnvironmentSelection(
    threadWithEnvironment(environment("stored", "/stored"), 20),
    {
      environments: [live],
      environmentSelectionEvidence: { source: "live", updatedAt: 10 },
    },
    "stored",
  );

  expect(result.environments).toEqual([live]);
  expect(result.environmentSelectionEvidence).toEqual({ source: "live", updatedAt: 10 });
});

test("accepted turn environments commit only when the dispatch selection is still current", () => {
  const captured = { source: "live" as const, updatedAt: 10 };
  const prepared = environment("prepared", "/prepared");
  const accepted = acceptCodexPreparedEnvironmentSelection(
    {
      environments: [environment("old", "/old")],
      environmentSelectionEvidence: captured,
    },
    [prepared],
    captured,
    11,
  );
  expect(accepted.environments).toEqual([prepared]);
  expect(accepted.environmentSelectionEvidence).toEqual({ source: "live", updatedAt: 11 });

  const newer = environment("newer", "/newer");
  const rejected = acceptCodexPreparedEnvironmentSelection(
    {
      environments: [newer],
      environmentSelectionEvidence: { source: "live", updatedAt: 12 },
    },
    [prepared],
    captured,
    13,
  );
  expect(rejected.environments).toEqual([newer]);
  expect(rejected.environmentSelectionEvidence).toEqual({ source: "live", updatedAt: 12 });
});

test("resume response environments obey the same live-selection race fence", () => {
  const captured = { source: "live" as const, updatedAt: 10 };
  const newer = environment("newer", "/newer");
  const current = {
    environments: [newer],
    environmentSelectionEvidence: { source: "live" as const, updatedAt: 12 },
  };
  const responseThread = threadWithEnvironment(environment("resume", "/resume"), 11);

  expect(resolveCodexAcceptedThreadEnvironmentSelection(responseThread, current, captured)).toEqual(
    current,
  );
});
