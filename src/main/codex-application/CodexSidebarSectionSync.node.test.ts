import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Stream from "effect/Stream";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { CoreModules } from "../core-runtime/CoreModules";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";
import { CodexThreadCatalog } from "./CodexThreadCatalog";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { make } from "./CodexSidebarSectionSync";

const section = {
  section_id: "section:work",
  kind: "custom" as const,
  name: "Work",
  rank_key: 1_000_000_000_000,
  revision: 1,
  lifecycle: "active" as const,
  direct_item_count: 1,
  effective_session_count: 1,
  has_running: false,
  has_unread: false,
};

const sectionWindow = () => ({
  value: {
    kind: "sidebar_section_window" as const,
    sections: {
      items: [section],
      next_cursor: null,
      authority: { projection_revision: 1 },
    },
  },
});

const projectWindow = () => ({
  value: {
    kind: "project_window" as const,
    projects: {
      items: [],
      next_cursor: null,
      authority: { projection_revision: 1 },
    },
  },
});

const task = {
  threadId: "thread:work",
  sessionId: "session:work",
  projectId: null,
  projectName: null,
  title: "Work task",
  preview: "",
  cwd: "/workspace",
  gitBranch: null,
  projectless: true,
  pinned: false,
  pinnedOrder: null,
  statusType: "idle" as const,
  statusActiveFlags: [],
  createdAt: 1,
  updatedAt: 2,
};

const harness = (
  mode: "unsupported" | "supported" | "persistent-failure",
  backendKind: "codex" | "acp" = "codex",
) => {
  let links: Array<{
    section_id: string;
    host_id: string;
    remote_section_id?: string | null;
    sync_state: "pending" | "ready" | "delete_pending" | "conflict" | "unsupported";
    observed_generation: number;
    last_error?: string | null;
    updated_at: string;
  }> = [];
  const applied: unknown[] = [];
  const requests: Array<{ method: string; params: unknown }> = [];
  let remoteCreated = false;
  let persistentFailure = mode === "persistent-failure";
  const workspace = {
    read: (request: { readonly kind: string }) =>
      Effect.sync(() => {
        if (request.kind === "sidebar_section_window") return sectionWindow() as never;
        if (request.kind === "sidebar_section_host_link_window") {
          return {
            value: {
              kind: "sidebar_section_host_link_window",
              links: {
                items: links,
                next_cursor: null,
                authority: { projection_revision: 1 },
              },
            },
          } as never;
        }
        if (request.kind === "sidebar_section_item_window") {
          return {
            value: {
              kind: "sidebar_section_item_window",
              items: {
                items:
                  mode === "supported"
                    ? [
                        {
                          placement_id: "session:session:work",
                          rank_key: 0,
                          revision: 1,
                          value: {
                            kind: "session",
                            task: {
                              session: {
                                id: "session:work",
                                project_id: null,
                                display_title: "Work task",
                                no_thread_fallback_title: "Work task",
                                pinned: false,
                                pinned_order: null,
                                archived: false,
                                archived_at: null,
                                unread: false,
                                thread_id: "thread:work",
                                order: 0,
                                created_at: "2026-01-01T00:00:00.000Z",
                                updated_at: "2026-01-01T00:00:01.000Z",
                              },
                              thread: null,
                            },
                          },
                        },
                      ]
                    : [],
                next_cursor: null,
                authority: { projection_revision: 1 },
              },
            },
          } as never;
        }
        if (request.kind === "project_window") return projectWindow() as never;
        throw new Error(`Unexpected Core read: ${request.kind}`);
      }),
    apply: (request: {
      readonly intent: {
        readonly kind: string;
        readonly link?: (typeof links)[number];
        readonly section_id?: string;
        readonly host_id?: string;
      };
    }) =>
      Effect.sync(() => {
        applied.push(request);
        if (request.intent.kind === "upsert_sidebar_section_host_link" && request.intent.link) {
          links = [
            ...links.filter(
              (link) =>
                link.section_id !== request.intent.link?.section_id ||
                link.host_id !== request.intent.link?.host_id,
            ),
            request.intent.link,
          ];
        }
        if (request.intent.kind === "delete_sidebar_section_host_link") {
          links = links.filter(
            (link) =>
              link.section_id !== request.intent.section_id ||
              link.host_id !== request.intent.host_id,
          );
        }
        return {
          status: "committed",
          commit: { commit_seq: applied.length, store_epoch: "epoch:test" },
          outcome: { affected_project_ids: [], affected_thread_ids: [] },
        } as never;
      }),
  };
  const gateway = CodexGateway.of({
    localHostId: "local",
    events: Stream.empty,
    connection: () => Effect.succeed({ kind: "ready" as const, hostId: "local", generation: 7 }),
    requestOnHost: (_hostId: string, method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === "threadSection/list") {
        if (mode === "unsupported") {
          return Effect.fail(
            codexRuntimeError({
              operation: "gateway.request",
              reason: "request",
              retryable: false,
              hostId: "local",
              generation: 7,
              method,
            }),
          );
        }
        return Effect.succeed({
          data: remoteCreated ? [{ id: "remote:work", name: "Work", appearance: null }] : [],
          nextCursor: null,
        });
      }
      if (method === "threadSection/create") {
        remoteCreated = true;
        return Effect.succeed({
          section: { id: "remote:work", name: "Work", appearance: null },
        });
      }
      if (method === "thread/list") {
        const listParams = params as {
          sectionId?: string | null;
          sortKey?: string | null;
        };
        if (listParams.sortKey === "section_position" && typeof listParams.sectionId !== "string") {
          return Effect.fail(
            codexRuntimeError({
              operation: "gateway.request",
              reason: "request",
              retryable: false,
              hostId: "local",
              generation: 7,
              method,
              cause: new Error("section-position sorting requires a section filter"),
            }),
          );
        }
        if (persistentFailure) {
          return Effect.fail(
            codexRuntimeError({
              operation: "gateway.request",
              reason: "request",
              retryable: false,
              hostId: "local",
              generation: 7,
              method,
              cause: new Error("persistent test failure"),
            }),
          );
        }
        const sectionId = listParams.sectionId;
        return Effect.succeed({
          data: sectionId === null ? [{ id: "thread:work" }] : [],
          nextCursor: null,
        });
      }
      if (method === "thread/section/move") return Effect.succeed({});
      throw new Error(`Unexpected gateway request: ${method}`);
    },
  } as unknown as CodexGateway["Service"]);
  const directory = CodexThreadDirectory.of({
    resolve: () =>
      Effect.succeed({
        durable: {
          executionHostId: "local",
          backendBinding:
            backendKind === "codex"
              ? { kind: "codex" }
              : {
                  kind: "acp",
                  agentDefinitionId: "claude-agent-acp",
                  instanceConfigId: "claude-main",
                },
        },
      } as never),
  } as unknown as CodexThreadDirectory["Service"]);
  const catalog = CodexThreadCatalog.of({
    listPalette: () => Effect.succeed(mode === "supported" ? [task] : []),
    ensureSession: () => Effect.succeed(null),
  } as unknown as CodexThreadCatalog["Service"]);
  const hosts = ExecutionHostRuntime.of({
    hosts: () => Effect.succeed(mode === "persistent-failure" ? [{ hostId: "local" }] : []),
  } as unknown as ExecutionHostRuntime["Service"]);
  const runtime = make.pipe(
    Effect.provideService(CodexGateway, gateway),
    Effect.provideService(CodexThreadCatalog, catalog),
    Effect.provideService(CodexThreadDirectory, directory),
    Effect.provideService(
      CoreModules,
      CoreModules.of({ workspace } as unknown as CoreModules["Service"]),
    ),
    Effect.provideService(ExecutionHostRuntime, hosts),
  );
  return {
    applied,
    requests,
    runtime,
    readLinks: () => links,
    setPersistentFailure: (value: boolean) => {
      persistentFailure = value;
    },
  };
};

it.effect("keeps Core Sections available when a host lacks Thread Section support", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = harness("unsupported");
      const service = yield* test.runtime;
      const result = yield* service.syncHost("local", "manual");

      assert.strictEqual(result.capability, "unsupported");
      assert.strictEqual(test.readLinks()[0]?.sync_state, "unsupported");
      assert.strictEqual(test.readLinks()[0]?.remote_section_id ?? null, null);
    }),
  ),
);

it.effect("lazily creates one remote Section and projects its first attached task", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = harness("supported");
      const service = yield* test.runtime;
      const result = yield* service.syncHost("local", "manual");

      assert.strictEqual(result.capability, "supported");
      assert.strictEqual(
        test.requests.filter((request) => request.method === "threadSection/create").length,
        1,
      );
      assert.isAtLeast(
        test.requests.filter((request) => request.method === "thread/section/move").length,
        1,
      );
      assert.deepEqual(
        test.readLinks().map((link) => [link.remote_section_id, link.sync_state]),
        [["remote:work", "ready"]],
      );
      const threadLists = test.requests
        .filter((request) => request.method === "thread/list")
        .map((request) => request.params as Record<string, unknown>);
      assert.isTrue(
        threadLists
          .filter((params) => params.sortKey === "section_position")
          .every((params) => typeof params.sectionId === "string"),
      );
      assert.deepInclude(
        threadLists.find((params) => params.sectionId === null),
        {
          sectionId: null,
          sortKey: "created_at",
          sortDirection: "asc",
          useStateDbOnly: true,
        },
      );
    }),
  ),
);

it.effect("never projects an ACP Thread into Codex-owned remote Sections", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = harness("supported", "acp");
      const service = yield* test.runtime;

      yield* service.syncHost("local", "manual");

      assert.isFalse(test.requests.some(({ method }) => method === "thread/section/move"));
    }),
  ),
);

it.effect("logs once per continuous background reconciliation failure episode", () => {
  const messages: unknown[] = [];
  const logger = Logger.make(({ message }) => messages.push(message));
  return Effect.scoped(
    Effect.gen(function* () {
      const test = harness("persistent-failure");
      const service = yield* test.runtime;

      yield* service.syncAll("periodic");
      yield* service.syncAll("periodic");

      assert.strictEqual(
        messages.filter(
          (message) => String(message) === "Sidebar Section host reconciliation failed",
        ).length,
        1,
      );

      test.setPersistentFailure(false);
      yield* service.syncAll("periodic");
      test.setPersistentFailure(true);
      yield* service.syncAll("periodic");

      assert.strictEqual(
        messages.filter(
          (message) => String(message) === "Sidebar Section host reconciliation failed",
        ).length,
        2,
      );
    }),
  ).pipe(Effect.withLogger(logger));
});
