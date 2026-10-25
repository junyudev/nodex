import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import { fileURLToPath } from "node:url";
import * as Application from "./Application.ts";
import { AgentRuntime } from "./Service.ts";
import type { AgentRuntimeMethod, AgentRuntimeOperations } from "./Interface.ts";
import { acpFailure } from "./AcpFailures.ts";

type Page = { cursor?: string; result: unknown };
const makeCall =
  (runtime: AgentRuntime["Service"]) =>
  <M extends AgentRuntimeMethod>(method: M, input: AgentRuntimeOperations[M]["input"]) =>
    runtime
      .handle({ id: method, method, input })
      .pipe(Effect.map((output) => output as AgentRuntimeOperations[M]["output"]));

type Peer = {
  cwd: string;
  otherCwd: string;
  call: ReturnType<typeof makeCall>;
  writePages: (pages: Page[]) => Effect.Effect<void, unknown>;
  replaceInstance: Effect.Effect<unknown, unknown>;
  requests: Effect.Effect<
    Array<{ method: string; cursor?: string; cwd?: string; sessionId?: string }>,
    unknown
  >;
};
const withPeer = (use: (peer: Peer) => Effect.Effect<void, unknown>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-acp-pagination-" });
    const cwd = yield* fs.realPath(home);
    const otherCwd = `${cwd}/other`;
    yield* fs.makeDirectory(otherCwd);
    const log = `${cwd}/requests.jsonl`;
    const pages = `${cwd}/pages.json`;
    yield* fs.writeFileString(log, "");
    const provider = {
      driver: "acpRegistry",
      enabled: true,
      config: {
        source: "local",
        discovery: "explicit",
        commandPath: process.execPath,
        commandArgs: [fileURLToPath(new URL("./testing/acp-management-peer.mjs", import.meta.url))],
      },
      environment: [
        { name: "ACP_MANAGEMENT_LOG", value: log, sensitive: false },
        { name: "ACP_MANAGEMENT_PAGES", value: pages, sensitive: false },
      ],
    };
    yield* Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      yield* use({
        cwd,
        otherCwd,
        call: makeCall(runtime),
        writePages: (value) => fs.writeFileString(pages, JSON.stringify(value)),
        replaceInstance: runtime.handle({
          id: "replace",
          method: "providers.configure",
          input: {
            providers: {
              first: {
                ...provider,
                environment: [
                  ...provider.environment,
                  { name: "ACP_PAGINATION_REVISION", value: "changed", sensitive: false },
                ],
              },
              second: provider,
            },
          },
        }),
        requests: fs.readFileString(log).pipe(
          Effect.map((text) =>
            text
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line)),
          ),
        ),
      });
    }).pipe(
      Effect.provide(
        Application.layer(
          { home, cwd, providers: { first: provider, second: provider } },
          () => Effect.void,
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer));

it.live("keeps native session IDs exact across listing, import mappings and deletion", () =>
  withPeer(({ cwd, call, writePages, requests }) =>
    Effect.gen(function* () {
      const importedIds = [" x ", "x", "n".repeat(1024)];
      const deletedId = ` ${"d".repeat(510)} `;
      yield* writePages([
        {
          result: {
            sessions: [...importedIds, deletedId].map((sessionId) => ({ sessionId, cwd })),
          },
        },
      ]);
      expect(
        (yield* call("acp.sessions.list", { instanceId: "first", cwd })).sessions.map(
          (session) => session.sessionId,
        ),
      ).toEqual([...importedIds, deletedId]);
      yield* call("acp.connection.start", { instanceId: "first", cwd, operationId: "connect" });
      const connected = yield* call("acp.operation.read", { operationId: "connect" }).pipe(
        Effect.repeat({
          until: (value) => value.phase !== "running",
          schedule: Schedule.spaced("10 millis"),
        }),
        Effect.timeout("5 seconds"),
      );
      expect(connected.phase).toBe("succeeded");
      yield* call("project.upsert", { id: "project", title: "Project", workspaceRoot: cwd });
      const threadIds: string[] = [];
      for (const [index, sessionId] of importedIds.entries()) {
        const prepared = yield* call("acp.sessions.prepareImport", {
          instanceId: "first",
          cwd,
          sessionId,
        });
        threadIds.push(prepared.threadId);
        yield* call("acp.sessions.import", {
          instanceId: "first",
          cwd: prepared.cwd,
          sessionId,
          commandId: `import-${index}`,
          threadId: prepared.threadId,
          projectId: "project",
          title: prepared.title,
          sourceFingerprint: prepared.sourceFingerprint,
          model: "fixture",
        });
        const snapshot = yield* call("thread.snapshot", { threadId: prepared.threadId });
        expect(snapshot.projection.providerThreads[0]?.nativeThreadRef?.nativeId).toBe(sessionId);
        expect(snapshot.projection.runs).toHaveLength(0);
        expect(
          (yield* call("acp.sessions.prepareImport", { instanceId: "first", cwd, sessionId }))
            .threadId,
        ).toBe(prepared.threadId);
      }
      expect(new Set(threadIds).size).toBe(importedIds.length);
      yield* call("acp.sessions.delete", { instanceId: "first", cwd, sessionId: deletedId });
      expect(
        (yield* requests)
          .filter((request) => request.method === "session/delete")
          .map((request) => request.sessionId),
      ).toEqual(["probe-session", deletedId]);
      const before = (yield* requests).length;
      for (const sessionId of ["", "n".repeat(1025)]) {
        expect(
          (yield* call("acp.sessions.prepareImport", { instanceId: "first", cwd, sessionId }).pipe(
            Effect.result,
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* call("acp.sessions.delete", { instanceId: "first", cwd, sessionId }).pipe(
            Effect.result,
          ))._tag,
        ).toBe("Failure");
      }
      expect((yield* requests).length).toBe(before);
    }),
  ),
);

it.live(
  "preserves opaque cursor bytes and rejects tokens from another instance or directory before spawning",
  () =>
    withPeer(({ cwd, otherCwd, call, writePages, requests }) =>
      Effect.gen(function* () {
        const token = ` \t${"x".repeat(2044)}\n `;
        yield* writePages([
          {
            result: {
              sessions: Array.from({ length: 256 }, (_, index) => ({
                sessionId: `native-${index}`,
                cwd,
              })),
              nextCursor: token,
            },
          },
          { cursor: token, result: { sessions: [{ sessionId: "last", cwd }] } },
        ]);
        const first = yield* call("acp.sessions.list", { instanceId: "first", cwd });
        expect(first.sessions).toHaveLength(256);
        expect(first.nextCursor).toBe(token);
        const before = (yield* requests).length;
        for (const target of [
          { instanceId: "second", cwd },
          { instanceId: "first", cwd: otherCwd },
        ]) {
          expect(
            acpFailure(
              yield* call("acp.sessions.list", { ...target, cursor: token }).pipe(Effect.flip),
            ).reason,
          ).toBe("invalid_request");
        }
        expect(
          acpFailure(
            yield* call("acp.sessions.list", { instanceId: "first", cwd, cursor: "unknown" }).pipe(
              Effect.flip,
            ),
          ).reason,
        ).toBe("invalid_request");
        expect((yield* requests).length).toBe(before);
        const second = yield* call("acp.sessions.list", {
          instanceId: "first",
          cwd,
          cursor: token,
        });
        expect(second.sessions[0]?.sessionId).toBe("last");
        expect(second.nextCursor).toBeNull();
        expect((yield* requests).filter((entry) => entry.method === "session/list")).toEqual([
          { method: "session/list", cwd },
          { method: "session/list", cwd, cursor: token },
        ]);
      }),
    ),
);

it.live("rejects cyclic Agent pagination without losing a valid first-page restart", () =>
  withPeer(({ cwd, call, writePages }) =>
    Effect.gen(function* () {
      for (const cycle of [
        [
          { result: { sessions: [], nextCursor: "A" } },
          { cursor: "A", result: { sessions: [], nextCursor: "A" } },
        ],
        [
          { result: { sessions: [], nextCursor: "A" } },
          { cursor: "A", result: { sessions: [], nextCursor: "B" } },
          { cursor: "B", result: { sessions: [], nextCursor: "A" } },
        ],
      ]) {
        yield* writePages(cycle);
        let page = yield* call("acp.sessions.list", { instanceId: "first", cwd });
        for (let index = 1; index < cycle.length - 1; index++) {
          page = yield* call("acp.sessions.list", {
            instanceId: "first",
            cwd,
            cursor: page.nextCursor!,
          });
        }
        const error = yield* call("acp.sessions.list", {
          instanceId: "first",
          cwd,
          cursor: page.nextCursor!,
        }).pipe(Effect.flip);
        expect(acpFailure(error)).toMatchObject({
          reason: "invalid_request",
          message: "The Agent returned a repeated session cursor.",
        });
      }
      yield* writePages([
        { result: { sessions: [], nextCursor: "valid" } },
        { cursor: "valid", result: { sessions: [] } },
      ]);
      yield* call("acp.sessions.list", { instanceId: "first", cwd });
      expect(
        (yield* call("acp.sessions.list", { instanceId: "first", cwd, cursor: "valid" }))
          .nextCursor,
      ).toBeNull();
    }),
  ),
);

it.live(
  "rejects malformed and oversized native pages instead of truncating or hiding entries",
  () =>
    withPeer(({ cwd, call, writePages }) =>
      Effect.gen(function* () {
        for (const result of [
          {
            sessions: Array.from({ length: 257 }, (_, index) => ({
              sessionId: `native-${index}`,
              cwd,
            })),
          },
          { sessions: [], nextCursor: "x".repeat(2049) },
          { sessions: [], nextCursor: 42 },
          { sessions: [{ sessionId: "", cwd }] },
          { sessions: [{ sessionId: "missing-directory" }] },
        ]) {
          yield* writePages([{ result }]);
          const error = yield* call("acp.sessions.list", { instanceId: "first", cwd }).pipe(
            Effect.flip,
          );
          expect(acpFailure(error).reason).toBe("probe_failed");
        }
      }),
    ),
);

it.live(
  "bounds a native traversal and expires tokens after a fresh traversal replaces it",
  () =>
    withPeer(({ cwd, call, writePages }) =>
      Effect.gen(function* () {
        yield* writePages(
          Array.from({ length: 101 }, (_, index) => ({
            ...(index === 0 ? {} : { cursor: String(index) }),
            result: { sessions: [], nextCursor: String(index + 1) },
          })),
        );
        let cursor: string | undefined;
        for (let index = 0; index < 100; index++) {
          const page = yield* call("acp.sessions.list", {
            instanceId: "first",
            cwd,
            ...(cursor === undefined ? {} : { cursor }),
          });
          cursor = page.nextCursor!;
        }
        expect(
          acpFailure(
            yield* call("acp.sessions.list", { instanceId: "first", cwd, cursor: cursor! }).pipe(
              Effect.flip,
            ),
          ),
        ).toMatchObject({
          reason: "invalid_request",
          message: "The Agent session listing exceeded its page budget.",
        });
        yield* writePages([{ result: { sessions: [] } }]);
        yield* call("acp.sessions.list", { instanceId: "first", cwd });
        expect(
          acpFailure(
            yield* call("acp.sessions.list", { instanceId: "first", cwd, cursor: "1" }).pipe(
              Effect.flip,
            ),
          ).reason,
        ).toBe("invalid_request");
      }),
    ),
  30_000,
);

it.live("expires issued cursors when their configured instance is replaced", () =>
  withPeer(({ cwd, call, writePages, replaceInstance, requests }) =>
    Effect.gen(function* () {
      yield* writePages([
        { result: { sessions: [], nextCursor: "A" } },
        { cursor: "A", result: { sessions: [] } },
      ]);
      yield* call("acp.sessions.list", { instanceId: "first", cwd });
      yield* replaceInstance;
      const count = (yield* requests).length;
      expect(
        acpFailure(
          yield* call("acp.sessions.list", { instanceId: "first", cwd, cursor: "A" }).pipe(
            Effect.flip,
          ),
        ).reason,
      ).toBe("invalid_request");
      expect((yield* requests).length).toBe(count);
      yield* call("acp.sessions.list", { instanceId: "first", cwd });
      expect(
        (yield* call("acp.sessions.list", { instanceId: "first", cwd, cursor: "A" })).nextCursor,
      ).toBeNull();
    }),
  ),
);

it.live(
  "bounds retained directory scopes and rejects an evicted continuation without spawning",
  () =>
    withPeer(({ cwd, otherCwd, call, writePages, requests }) =>
      Effect.gen(function* () {
        yield* writePages([
          { result: { sessions: [], nextCursor: "A" } },
          { cursor: "A", result: { sessions: [] } },
        ]);
        yield* call("acp.sessions.list", { instanceId: "first", cwd });
        for (let index = 0; index < 64; index++) {
          yield* call("acp.sessions.list", {
            instanceId: "first",
            cwd: `${otherCwd}${"/".repeat(index + 1)}`,
          });
        }
        const count = (yield* requests).length;
        expect(
          acpFailure(
            yield* call("acp.sessions.list", { instanceId: "first", cwd, cursor: "A" }).pipe(
              Effect.flip,
            ),
          ).reason,
        ).toBe("invalid_request");
        expect((yield* requests).length).toBe(count);
      }),
    ),
  30_000,
);
