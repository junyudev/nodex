import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { AgentImportProgress } from "../../shared/agent-import";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { make } from "./AgentImportRuntime";
import { CodexApplicationEventHub, type CodexApplicationEvent } from "./CodexApplicationEventHub";
import { CodexExternalAgentImportRuntime } from "./CodexExternalAgentImportRuntime";
import { CodexSidebarSyncRuntime } from "./CodexSidebarSyncRuntime";
import { CodexThreadDirectory, CodexThreadDirectoryError } from "./CodexThreadDirectory";
import { ThreadCreationRuntime } from "./ThreadCreationRuntime";
import { transparentThreadCreationRuntime } from "./ThreadCreationRuntime.test-support";
import { CodexThreadTitlePersistence } from "./CodexThreadTitlePersistence";

const SOURCE_THREAD_ID = "019c0000-0000-7000-8000-000000000003";
const TARGET_THREAD_ID = "019c0000-0000-7000-8000-000000000004";

interface ImportHarnessOptions {
  readonly onAcceptImport?: CodexThreadDirectory["Service"]["acceptImportResult"];
  readonly returnsTranscript?: boolean;
}

const temporaryRoot = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(path.join(tmpdir(), "nodex-agent-import-"))),
  (root) => Effect.sync(() => rmSync(root, { force: true, recursive: true })),
);

const prepareSession = (root: string) => {
  const sourceHome = path.join(root, "source", ".openinterpreter");
  const runtimeStateHome = path.join(root, "target", "agent");
  const cwd = path.join(root, "workspace");
  mkdirSync(path.join(sourceHome, "sessions"), { recursive: true });
  mkdirSync(runtimeStateHome, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    path.join(sourceHome, "session_index.jsonl"),
    `${JSON.stringify({ id: SOURCE_THREAD_ID, thread_name: "Imported conversation" })}\n`,
  );
  writeFileSync(
    path.join(sourceHome, "sessions", "rollout.jsonl"),
    `${JSON.stringify({
      payload: { cwd, id: SOURCE_THREAD_ID },
      type: "session_meta",
    })}\n`,
  );
  return { cwd, runtimeStateHome, sourceHome };
};

const makeHarness = (runtimeStateHome: string, cwd: string, options: ImportHarnessOptions = {}) => {
  const requests: Array<{
    readonly method: string;
    readonly params: unknown;
    readonly scheduling: unknown;
  }> = [];
  const acceptedImports: unknown[] = [];
  const titles: unknown[] = [];
  const events: CodexApplicationEvent[] = [];
  let sidebarSyncs = 0;

  const capability = createCodexAppServerCapabilitySnapshot({
    hostId: "local",
    generation: 13,
    userAgent: "codex-app-server/0.145.0-alpha.15",
  });
  const requestLocal = ((method: string, params: unknown, scheduling: unknown) =>
    Effect.sync(() => {
      requests.push({ method, params, scheduling });
      if (method === "thread/fork") {
        return {
          cwd,
          thread: {
            cwd,
            historyMode: "paginated",
            id: TARGET_THREAD_ID,
            name: null,
            turns: options.returnsTranscript ? [{ id: "poison-turn", items: [] }] : [],
          },
        };
      }
      if (method === "thread/delete") return {};
      throw new Error(`Unexpected local request: ${method}`);
    })) as CodexGateway["Service"]["requestLocal"];
  const gateway = CodexGateway.of({
    events: Stream.empty,
    localHostId: "local",
    requestLocal,
  } as unknown as CodexGateway["Service"]);
  const directory = CodexThreadDirectory.of({
    acceptImportResult:
      options.onAcceptImport ??
      ((input) =>
        Effect.sync(() => {
          acceptedImports.push(input);
          return {} as never;
        })),
  } as CodexThreadDirectory["Service"]);
  const titlePersistence = CodexThreadTitlePersistence.of({
    setRequired: (input: Parameters<CodexThreadTitlePersistence["Service"]["setRequired"]>[0]) =>
      Effect.sync(() => {
        titles.push(input);
        return true;
      }),
  } as unknown as CodexThreadTitlePersistence["Service"]);
  const sidebar = CodexSidebarSyncRuntime.of({
    sync: () =>
      Effect.sync(() => {
        sidebarSyncs += 1;
        return {} as never;
      }),
  } as unknown as CodexSidebarSyncRuntime["Service"]);

  return {
    acceptedImports,
    events,
    requests,
    sidebarSyncs: () => sidebarSyncs,
    titles,
    runtime: make({ runtimeStateHome }).pipe(
      Effect.provideService(
        CodexAppServerCapabilities,
        CodexAppServerCapabilities.of({
          forHost: () => Effect.succeed(capability),
          forThread: () => Effect.succeed(capability),
          isCurrent: () => Effect.succeed(true),
        }),
      ),
      Effect.provideService(
        CodexApplicationEventHub,
        CodexApplicationEventHub.of({
          events: Stream.empty,
          publish: (event) => events.push(event),
        }),
      ),
      Effect.provideService(
        CodexExternalAgentImportRuntime,
        CodexExternalAgentImportRuntime.of({ run: () => Effect.die("unused") }),
      ),
      Effect.provideService(CodexGateway, gateway),
      Effect.provideService(CodexSidebarSyncRuntime, sidebar),
      Effect.provideService(CodexThreadDirectory, directory),
      Effect.provideService(ThreadCreationRuntime, transparentThreadCreationRuntime),
      Effect.provideService(CodexThreadTitlePersistence, titlePersistence),
    ),
  };
};

it.effect("imports a native rollout through the canonical services and records it once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const source = prepareSession(root);
      const harness = makeHarness(source.runtimeStateHome, source.cwd);
      const runtime = yield* harness.runtime;

      const scan = yield* runtime.scan("open-interpreter", source.sourceHome);
      const sessionItem = scan.items.find((item) => item.kind === "sessions");
      assert.isDefined(sessionItem);
      const result = yield* runtime.apply({ scanId: scan.scanId, itemIds: [sessionItem.id] });

      assert.deepEqual(result.importedThreadIds, [TARGET_THREAD_ID]);
      assert.deepEqual(
        harness.requests.map(({ method }) => method),
        ["thread/fork"],
      );
      assert.deepEqual(harness.requests[0]?.scheduling, {
        expectedHostId: "local",
        expectedGeneration: 13,
      });
      assert.strictEqual(harness.acceptedImports.length, 1);
      assert.deepEqual(harness.titles, [
        { name: "Imported conversation", normalization: "trim", threadId: TARGET_THREAD_ID },
      ]);
      assert.strictEqual(harness.sidebarSyncs(), 1);
      const progress = harness.events.flatMap((event): AgentImportProgress[] =>
        event.kind === "agentImportProgress" ? [event.value] : [],
      );
      assert.isFalse(progress[0]?.completed ?? true);
      assert.isTrue(progress.at(-1)?.completed ?? false);

      const ledger = JSON.parse(
        readFileSync(
          path.join(source.runtimeStateHome, "imports", "session-imports-v1.json"),
          "utf8",
        ),
      ) as { readonly sessions: ReadonlyArray<{ readonly targetThreadId: string }> };
      assert.deepEqual(
        ledger.sessions.map(({ targetThreadId }) => targetThreadId),
        [TARGET_THREAD_ID],
      );
      const consumed = yield* Effect.flip(
        runtime.apply({ scanId: scan.scanId, itemIds: [sessionItem.id] }),
      );
      assert.strictEqual(consumed.reason, "expired-scan");
      const secondScan = yield* runtime.scan("open-interpreter", source.sourceHome);
      assert.isFalse(secondScan.items.some((item) => item.kind === "sessions"));
      assert.strictEqual(secondScan.skippedAlreadyImportedSessions, 1);
    }),
  ),
);

it.effect("deletes a fork when canonical materialization fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const source = prepareSession(root);
      const harness = makeHarness(source.runtimeStateHome, source.cwd, {
        onAcceptImport: () =>
          Effect.fail(
            new CodexThreadDirectoryError({
              operation: "materialize",
              threadId: TARGET_THREAD_ID,
              cause: new Error("projection failed"),
            }),
          ),
      });
      const runtime = yield* harness.runtime;
      const scan = yield* runtime.scan("open-interpreter", source.sourceHome);
      const sessionItem = scan.items.find((item) => item.kind === "sessions");
      assert.isDefined(sessionItem);

      const result = yield* runtime.apply({ scanId: scan.scanId, itemIds: [sessionItem.id] });

      assert.deepEqual(
        harness.requests.map(({ method }) => method),
        ["thread/fork", "thread/delete"],
      );
      assert.deepEqual(result.importedThreadIds, []);
      assert.strictEqual(result.outcomes[0]?.failureCount, 1);
      assert.match(result.outcomes[0]?.messages[0] ?? "", /projection failed/u);
      assert.strictEqual(harness.sidebarSyncs(), 0);
    }),
  ),
);

it.effect("rejects and deletes an import response that carries transcript history", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const source = prepareSession(root);
      const harness = makeHarness(source.runtimeStateHome, source.cwd, {
        returnsTranscript: true,
      });
      const runtime = yield* harness.runtime;
      const scan = yield* runtime.scan("open-interpreter", source.sourceHome);
      const sessionItem = scan.items.find((item) => item.kind === "sessions");
      assert.isDefined(sessionItem);

      const result = yield* runtime.apply({ scanId: scan.scanId, itemIds: [sessionItem.id] });

      assert.deepEqual(
        harness.requests.map(({ method }) => method),
        ["thread/fork", "thread/delete"],
      );
      assert.strictEqual(harness.acceptedImports.length, 0);
      assert.deepEqual(result.importedThreadIds, []);
      assert.match(result.outcomes[0]?.messages[0] ?? "", /metadata-only paginated history/u);
    }),
  ),
);
