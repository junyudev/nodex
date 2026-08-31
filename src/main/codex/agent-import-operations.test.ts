import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, test } from "vite-plus/test";
import { createCodexAppServerCapabilitySnapshot } from "../codex-runtime/CodexAppServerCapabilities";
import {
  agentImportInternals,
  makeAgentImportOperations,
  type PendingImportItem,
  type PendingImportScan,
} from "./agent-import-operations";

describe("agent import config policy", () => {
  test("keeps only absent, passive config keys", () => {
    const edits = agentImportInternals.buildSafeConfigEdits(
      {
        approval_policy: "never",
        features: { search: true },
        model: "private-model",
        notify: ["private-command"],
        web_search: "live",
      },
      { features: { search: false } },
    );
    expect(edits).toEqual([{ keyPath: "web_search", label: "web_search", value: "live" }]);
  });

  test("removes credentials when translating MCP servers", () => {
    const edits = agentImportInternals.buildMcpConfigEdits(
      {
        mcp_servers: {
          docs: {
            command: "docs-server",
            env: { API_KEY: "must-be-reauthorized" },
          },
        },
      },
      {},
    );
    expect(edits).toEqual([
      {
        keyPath: "mcp_servers",
        label: "docs",
        value: { docs: { command: "docs-server" } },
      },
    ]);
  });

  it.effect("forks imported sessions without returning their transcript", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(path.join(tmpdir(), "nodex-agent-import-history-"))),
      (root) =>
        Effect.gen(function* () {
          const sourcePath = path.join(root, "source-session.jsonl");
          const sourceContent = '{"type":"session_meta","payload":{"id":"source"}}\n';
          yield* Effect.promise(() => writeFile(sourcePath, sourceContent, "utf8"));
          const sourceContentSha256 = createHash("sha256").update(sourceContent).digest("hex");
          const item: PendingImportItem = {
            id: "sessions",
            kind: "sessions",
            label: "Recent conversations",
            description: "Import one conversation",
            count: 1,
            defaultSelected: true,
            payload: {
              type: "sessions",
              sessions: [
                {
                  sourcePath,
                  sourceContentSha256,
                  sourceThreadId: "source-thread",
                  cwd: root,
                  title: null,
                },
              ],
            },
          };
          const pendingScan: PendingImportScan = {
            itemsById: new Map([[item.id, item]]),
            scan: {
              scanId: "scan",
              sourceKind: "codex",
              sourceLabel: "Codex",
              sourceHome: root,
              expiresAt: Number.MAX_SAFE_INTEGER,
              items: [item],
              skippedAlreadyImportedSessions: 0,
            },
            sourceHome: root,
          };
          const forkRequests: Array<{ readonly params: unknown; readonly scheduling: unknown }> =
            [];
          const acceptedResponses: unknown[] = [];
          const capability = createCodexAppServerCapabilitySnapshot({
            hostId: "local",
            generation: 7,
            userAgent: "codex-app-server/0.145.0-alpha.15",
          });
          const response = {
            thread: {
              id: "imported-thread",
              cwd: root,
              historyMode: "paginated",
              name: "Imported Thread",
              turns: [],
            },
            cwd: root,
          };
          const operations = makeAgentImportOperations(
            { runtimeStateHome: path.join(root, "runtime") },
            {
              capabilities: { forHost: () => Effect.succeed(capability) },
              events: { publish: () => undefined },
              externalImport: { run: () => Effect.die("unused") },
              gateway: {
                localHostId: "local",
                requestLocal: (method: string, params: unknown, scheduling: unknown) => {
                  if (method !== "thread/fork") return Effect.die(`Unexpected request: ${method}`);
                  forkRequests.push({ params, scheduling });
                  return Effect.succeed(response);
                },
              },
              sidebarSync: { sync: () => Effect.succeed({}) },
              threadDirectory: {
                acceptImportResult: (input: unknown) => {
                  acceptedResponses.push(input);
                  return Effect.succeed({});
                },
              },
              threadStarts: {
                materialize: (
                  _hostId: string,
                  _generation: number,
                  operation: Effect.Effect<unknown>,
                ) => operation,
              },
              threadTitles: { setRequired: () => Effect.die("unused") },
            } as never,
          );

          const result = yield* operations.apply(
            { scanId: pendingScan.scan.scanId, itemIds: [item.id] },
            pendingScan,
            "import",
            100,
          );

          expect(result.importedThreadIds).toEqual(["imported-thread"]);
          expect(forkRequests).toEqual([
            {
              params: expect.objectContaining({
                excludeTurns: true,
                path: sourcePath,
                threadId: "source-thread",
              }),
              scheduling: {
                expectedGeneration: 7,
                expectedHostId: "local",
              },
            },
          ]);
          expect(acceptedResponses).toEqual([
            expect.objectContaining({
              executionHostId: "local",
              response: expect.objectContaining({
                thread: expect.objectContaining({ id: "imported-thread", turns: [] }),
              }),
            }),
          ]);
        }),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    ),
  );
});
