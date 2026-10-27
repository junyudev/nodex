import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import {
  readSessionExecutionDetails,
  type RuntimeSessionReadExecution,
} from "./SessionReadDetails";
import {
  sessionObservationSchemas,
  sessionObservationToolCatalog,
} from "../../shared/nodex-app-tools/session-observation-schemas";

it.effect(
  "continues every Run omitted by metadata admission and binds cursors to the Session store",
  () =>
    Effect.gen(function* () {
      const rows = Array.from({ length: 40 }, (_, index) => ({
        runId: `run:${40 - index}`,
        ordinal: 40 - index,
        status: "completed" as const,
        providerInstanceId: "codex",
        model: "m".repeat(600),
        requestedAt: "2026-10-27T00:00:00.000Z",
        startedAt: null,
        completedAt: "2026-10-27T00:01:00.000Z",
      }));
      const application = {
        sessionMetadata: () => Effect.succeed([]),
        readDetails: ({
          beforeOrdinal,
          runLimit,
        }: {
          beforeOrdinal?: number;
          runLimit: number;
        }) => {
          const matching = rows.filter(
            (row) => beforeOrdinal === undefined || row.ordinal < beforeOrdinal,
          );
          const recentRuns = matching.slice(0, runLimit);
          return Effect.succeed({
            runCount: rows.length,
            pendingRequestCount: 0,
            recentRuns,
            nextOrdinal: matching.length > runLimit ? recentRuns.at(-1)!.ordinal : null,
          });
        },
      } as unknown as AgentRuntimeApplication["Service"];
      const read = (runCursor?: string, binding = "store:a") =>
        readSessionExecutionDetails({
          application,
          sessionId: "session:a",
          threadId: "thread:a",
          runtimeId: "runtime",
          binding,
          runLimit: 40,
          base: { sessionId: "session:a" },
          ...(runCursor === undefined ? {} : { runCursor }),
        });
      const initial = yield* read();
      assert.isBelow(initial.recentRuns.length, rows.length);
      assert.isNotNull(initial.runsPage.nextCursor);
      const actual = [...initial.recentRuns];
      let cursor: string | null = initial.runsPage.nextCursor;
      while (cursor !== null) {
        const page: RuntimeSessionReadExecution = yield* read(cursor);
        actual.push(...page.recentRuns);
        assert.notEqual(page.runsPage.nextCursor, cursor);
        cursor = page.runsPage.nextCursor;
      }
      assert.deepEqual(
        actual.map((row) => row.runId),
        rows.map((row) => row.runId),
      );
      const invalid = yield* read(initial.runsPage.nextCursor!, "store:b").pipe(Effect.result);
      assert.equal(invalid._tag, "Failure");
      if (invalid._tag === "Failure") assert.equal(invalid.failure.reason, "invalid_cursor");
    }),
);

it("normalizes positive read budgets while rejecting empty requests", () => {
  const parsed = sessionObservationSchemas.read_session.parse({
    limit: 1000,
    runLimit: 1000,
    maxCharsPerItem: 100000,
  });
  assert.equal(parsed.limit, 50);
  assert.equal(parsed.runLimit, 50);
  assert.equal(parsed.maxCharsPerItem, 8000);
  for (const field of ["limit", "runLimit", "maxCharsPerItem"])
    assert.isFalse(sessionObservationSchemas.read_session.safeParse({ [field]: 0 }).success);
  const tool = sessionObservationToolCatalog.find((tool) => tool.name === "read_session")!;
  assert.isDefined(tool.inputSchema.properties?.runCursor);
});
