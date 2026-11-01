import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import type { ProjectWorkspaceApplyInput, ProjectWorkspaceRead } from "../core-client/types";
import type { AgentRuntimeApplicationConnection } from "./AgentRuntimeApplication";
import { make } from "./AgentRuntimeSessionOrdering";

const fixture = (options: { failRelay?: boolean } = {}) => {
  const calls: string[] = [];
  const applied: ProjectWorkspaceApplyInput[] = [];
  const catalogInputs: AgentRuntimeOperations["sessions.catalog"]["input"][] = [];
  const pages: Array<{ threadId: string; latestUserAuthoredMessageAt: string | null }[]> = [];
  const bindings = new Map([
    ["root:one", "session:one"],
    ["root:two", "session:two"],
  ]);
  const observed = new Map<string, number>();
  const connection: AgentRuntimeApplicationConnection = {
    identity: {
      runtimeId: "runtime",
      runtimeGeneration: "generation",
      schemaVersion: 1,
      databasePath: "/unused",
      mcpEndpoint: "http://unused",
      lastSequence: 0,
    },
    request: (method, input) =>
      Effect.gen(function* () {
        calls.push(method);
        if (method === "sessions.catalog") {
          const query = input as AgentRuntimeOperations["sessions.catalog"]["input"];
          catalogInputs.push(query);
          const index = query.cursor ? Number(query.cursor) : 0;
          return {
            items: pages[index] ?? [],
            nextCursor: index + 1 < pages.length ? String(index + 1) : null,
          } as AgentRuntimeOperations[typeof method]["output"];
        }
        return { sequence: 17 } as AgentRuntimeOperations[typeof method]["output"];
      }),
  };
  const owner = make().pipe(
    Effect.provideService(CoreModules, {
      workspace: {
        read: (input: ProjectWorkspaceRead) =>
          Effect.sync(() => {
            calls.push("resolve");
            const session =
              input.kind === "agent_runtime_session_binding_by_execution" &&
              input.runtime_id === "runtime"
                ? bindings.get(input.runtime_thread_id)
                : undefined;
            return {
              value: {
                kind: "agent_runtime_session_binding",
                binding: session ? { session_id: session } : null,
              },
            };
          }),
        apply: (input: ProjectWorkspaceApplyInput) =>
          Effect.gen(function* () {
            assert.isNull(yield* CoreApplicationAgent);
            calls.push("relay");
            if (options.failRelay) return yield* Effect.fail("Core unavailable");
            applied.push(input);
            if (input.intent.kind === "record_session_activity")
              for (const entry of input.intent.entries) {
                observed.set(
                  entry.session_id,
                  Math.max(observed.get(entry.session_id) ?? 0, entry.at_ms),
                );
              }
            return {};
          }),
      },
    } as never),
  );
  return { owner, connection, calls, applied, pages, catalogInputs, observed };
};

it.effect("reconciliation pages only bound roots, skips absent clocks, and is idempotent", () =>
  Effect.gen(function* () {
    const test = fixture();
    const owner = yield* test.owner;
    test.pages.push(
      [
        { threadId: "root:one", latestUserAuthoredMessageAt: "2026-01-01T00:00:00.000Z" },
        { threadId: "unknown", latestUserAuthoredMessageAt: "2026-01-02T00:00:00.000Z" },
        { threadId: "empty", latestUserAuthoredMessageAt: null },
      ],
      [{ threadId: "root:two", latestUserAuthoredMessageAt: "2026-02-01T00:00:00.000Z" }],
    );
    yield* owner.reconcile(test.connection);
    const before = [...test.observed];
    assert.deepEqual(before, [
      ["session:one", Date.parse("2026-01-01T00:00:00.000Z")],
      ["session:two", Date.parse("2026-02-01T00:00:00.000Z")],
    ]);
    assert.deepEqual(test.catalogInputs, [
      { limit: 100, includeSubagents: false },
      { cursor: "1", limit: 100, includeSubagents: false },
    ]);
    yield* owner.reconcile(test.connection);
    assert.deepEqual([...test.observed], before);
    assert.deepEqual(new Set(test.calls), new Set(["sessions.catalog", "resolve", "relay"]));
  }),
);

it.effect("a Core failure leaves reconciliation for the next Runtime connection", () =>
  Effect.gen(function* () {
    const test = fixture({ failRelay: true });
    const owner = yield* test.owner;
    test.pages.push([
      { threadId: "root:one", latestUserAuthoredMessageAt: "2026-01-01T00:00:00.000Z" },
    ]);
    yield* owner.reconcile(test.connection);
    assert.deepEqual(test.applied, []);
  }),
);
