import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExternalAgentConfigMigrationItem } from "@nodex/codex-app-server-protocol/v2/ExternalAgentConfigMigrationItem";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { AgentImportProgress } from "../../shared/agent-import";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { make } from "./AgentImportRuntime";
import { CodexApplicationEventHub, type CodexApplicationEvent } from "./CodexApplicationEventHub";
import { CodexExternalAgentImportRuntime } from "./CodexExternalAgentImportRuntime";

const temporaryRoot = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(path.join(tmpdir(), "nodex-agent-setup-import-"))),
  (root) => Effect.sync(() => rmSync(root, { force: true, recursive: true })),
);

const write = (file: string, contents: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
};

const prepareSource = (root: string) => {
  const sourceHome = path.join(root, "source", ".codex");
  const codexHome = path.join(root, "target", ".codex");
  const rollout = JSON.stringify({
    type: "session_meta",
    payload: { id: "019c0000-0000-7000-8000-000000000003", cwd: path.join(root, "missing") },
  });
  const sessionPath = path.join(sourceHome, "sessions", "rollout.jsonl");
  const archivePath = path.join(sourceHome, "archived_sessions", "rollout.jsonl");
  write(sessionPath, rollout);
  write(archivePath, rollout);
  mkdirSync(codexHome, { recursive: true });
  return { sourceHome, codexHome, sessionPath, archivePath, rollout };
};

const makeHarness = (
  codexHome: string,
  sourceHome: string,
  migrations: readonly ExternalAgentConfigMigrationItem[] = [],
) => {
  const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
  const externalImports: Array<readonly ExternalAgentConfigMigrationItem[]> = [];
  const events: CodexApplicationEvent[] = [];
  const unsupported = () => Effect.die(new Error("Unexpected setup import gateway operation"));
  const gateway = CodexGateway.of({
    events: Stream.empty,
    localHostId: "local",
    promoteQueuedCatalogPage: unsupported(),
    requestLocal: ((method: string, params: unknown) =>
      Effect.sync(() => {
        requests.push({ method, params });
        if (method === "externalAgentConfig/detect") return { items: migrations };
        if (method === "config/batchWrite") return {};
        throw new Error(`Unexpected setup import request: ${method}`);
      })) as CodexGateway["Service"]["requestLocal"],
    requestOnHost: unsupported,
    requestRawOnHost: unsupported,
    requestForThread: unsupported,
    requestRawForThread: unsupported,
    notifyLocal: unsupported,
    connection: unsupported,
    connectionChanges: () => Stream.die(new Error("Unexpected setup import gateway subscription")),
    awaitReady: unsupported,
    reconcileHost: unsupported,
    removeHost: unsupported,
    restartHost: unsupported,
  });
  return {
    requests,
    externalImports,
    events,
    runtime: make({
      codexHome,
      sourceHomes: { codex: sourceHome, "claude-code": sourceHome },
    }).pipe(
      Effect.provideService(CodexGateway, gateway),
      Effect.provideService(
        CodexApplicationEventHub,
        CodexApplicationEventHub.of({
          events: Stream.empty,
          publish: (event) => events.push(event),
        }),
      ),
      Effect.provideService(
        CodexExternalAgentImportRuntime,
        CodexExternalAgentImportRuntime.of({
          run: (items) =>
            Effect.sync(() => {
              externalImports.push(items);
              return {
                importId: "external-setup",
                itemTypeResults: items.map(({ itemType, cwd }) => ({
                  itemType,
                  failures: [],
                  successes: [{ itemType, cwd, source: null, target: null, title: null }],
                })),
              };
            }),
        }),
      ),
    ),
  };
};

it.effect("copies selected setup without importing or changing conversations from that home", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const source = prepareSource(root);
      write(path.join(source.sourceHome, "AGENTS.md"), "Use the shared project conventions.\n");
      write(path.join(source.sourceHome, "skills", "review", "SKILL.md"), "Review a change.\n");
      const harness = makeHarness(source.codexHome, source.sourceHome);
      const runtime = yield* harness.runtime;
      const scan = yield* runtime.scan("codex", source.sourceHome);
      assert.deepEqual(
        scan.items.map(({ kind }) => kind),
        ["instructions", "skills"],
      );

      const result = yield* runtime.apply({
        scanId: scan.scanId,
        itemIds: scan.items.map(({ id }) => id),
      });
      assert.deepEqual(
        result.outcomes.map(({ successCount }) => successCount),
        [1, 1],
      );
      assert.strictEqual(
        readFileSync(path.join(source.codexHome, "AGENTS.md"), "utf8"),
        "Use the shared project conventions.\n",
      );
      assert.strictEqual(
        readFileSync(
          path.join(path.dirname(source.codexHome), ".agents", "skills", "review", "SKILL.md"),
          "utf8",
        ),
        "Review a change.\n",
      );
      assert.strictEqual(readFileSync(source.sessionPath, "utf8"), source.rollout);
      assert.strictEqual(readFileSync(source.archivePath, "utf8"), source.rollout);
      assert.isFalse(existsSync(path.join(source.codexHome, "sessions")));
      assert.deepEqual(harness.requests, []);
      assert.deepEqual(harness.externalImports, []);
      const progress = harness.events.flatMap((event): AgentImportProgress[] =>
        event.kind === "agentImportProgress" ? [event.value] : [],
      );
      assert.isFalse(progress[0]?.completed ?? true);
      assert.isTrue(progress.at(-1)?.completed ?? false);
      const retry = yield* Effect.flip(
        runtime.apply({ scanId: scan.scanId, itemIds: scan.items.map(({ id }) => id) }),
      );
      assert.strictEqual(retry.reason, "expired-scan");
      assert.deepEqual((yield* runtime.scan("codex", source.sourceHome)).items, []);
    }),
  ),
);

it.effect(
  "leaves active-home configuration and history unchanged when there is nothing to copy",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRoot;
        const source = prepareSource(root);
        const config = "model = 'native-model'\n";
        write(path.join(source.sourceHome, "config.toml"), config);
        const harness = makeHarness(source.sourceHome, source.sourceHome);
        const runtime = yield* harness.runtime;
        assert.deepEqual((yield* runtime.scan("codex")).items, []);
        assert.strictEqual(
          readFileSync(path.join(source.sourceHome, "config.toml"), "utf8"),
          config,
        );
        assert.strictEqual(readFileSync(source.sessionPath, "utf8"), source.rollout);
        assert.deepEqual(harness.requests, []);
      }),
    ),
);

it.effect("submits only Claude setup categories even when detection includes conversations", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const source = prepareSource(root);
      const instructions: ExternalAgentConfigMigrationItem = {
        itemType: "AGENTS_MD",
        description: "Instructions",
        cwd: null,
        details: null,
      };
      const sessions: ExternalAgentConfigMigrationItem = {
        itemType: "SESSIONS",
        description: "Conversations",
        cwd: null,
        details: null,
      };
      const harness = makeHarness(source.codexHome, source.sourceHome, [sessions, instructions]);
      const runtime = yield* harness.runtime;
      const scan = yield* runtime.scan("claude-code");
      assert.deepEqual(
        scan.items.map(({ kind }) => kind),
        ["instructions"],
      );
      const rejected = yield* Effect.flip(
        runtime.apply({ scanId: scan.scanId, itemIds: ["sessions"] }),
      );
      assert.strictEqual(rejected.reason, "apply-failed");
      assert.deepEqual(harness.externalImports, []);
      const result = yield* runtime.apply({
        scanId: scan.scanId,
        itemIds: scan.items.map(({ id }) => id),
      });
      assert.deepEqual(harness.externalImports, [[instructions]]);
      assert.strictEqual(result.outcomes[0]?.successCount, 1);
      assert.deepEqual(
        harness.requests.map(({ method }) => method),
        ["externalAgentConfig/detect"],
      );
    }),
  ),
);
