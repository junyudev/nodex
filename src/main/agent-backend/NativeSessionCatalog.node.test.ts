import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { Thread } from "@nodex/codex-app-server-protocol/v2/Thread";
import type {
  CodexThreadImportInput,
  NativeSessionAttachInput,
  NativeSessionAttachResult,
  NativeSessionCatalogInput,
  NativeSessionCatalogPage,
} from "../../shared/native-session-catalog";
import { AgentBackendApplication } from "./AgentBackendApplication";
import { make } from "./NativeSessionCatalog";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import type { DesktopProjectWorkspaceThread } from "../core-client/project-workspace-adapter";

const SESSION_ID = "019d0000-0000-7000-8000-000000000001";
const importInput = (
  home: string,
  cwd: string,
  patch: Partial<CodexThreadImportInput> = {},
): CodexThreadImportInput => ({
  requestId: "019d0000-0000-7000-8000-000000000002",
  acceptedAt: 20_000,
  nativeSessionId: SESSION_ID,
  expectedHome: home,
  projectId: null,
  cwd,
  ...patch,
});
const temporaryRoot = Effect.acquireRelease(
  Effect.sync(() => realpathSync(mkdtempSync(join(tmpdir(), "nodex-native-catalog-")))),
  (root) => Effect.sync(() => rmSync(root, { force: true, recursive: true })),
);

const nativeThread = (cwd: string, patch: Partial<Thread> = {}): Thread =>
  ({
    id: SESSION_ID,
    name: "CLI conversation",
    preview: "Earlier task",
    cwd,
    ephemeral: false,
    parentThreadId: null,
    source: "cli",
    createdAt: 10,
    updatedAt: 20,
    turns: [],
    ...patch,
  }) as Thread;

const harness = (
  root: string,
  options: {
    readonly threads?: readonly Thread[];
    readonly readThread?: Thread;
    readonly nextCursor?: string;
    readonly durableThreads?: readonly DesktopProjectWorkspaceThread[];
    readonly afterRead?: () => void;
    readonly claudePage?: NativeSessionCatalogPage;
  } = {},
) => {
  const home = join(root, "native-home");
  const cwd = join(root, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  let activeHome = home;
  const requests: Array<{ method: string; params: unknown }> = [];
  const admissions: Parameters<ProjectWorkspace["Service"]["attachNativeSession"]>[0][] = [];
  const claudeLists: NativeSessionCatalogInput[] = [];
  const claudeAttachments: NativeSessionAttachInput[] = [];
  const result: NativeSessionAttachResult = {
    sessionId: "nodex-session",
    threadId: SESSION_ID,
    alreadyAttached: false,
  };
  const settings = {
    snapshot: () => Effect.succeed({ codexHome: { activeHomePath: activeHome } }),
  } as unknown as ApplicationSettings["Service"];
  const gateway = {
    requestLocal: (method: string, params: unknown) =>
      Effect.sync(() => {
        requests.push({ method, params });
        if (method === "thread/list")
          return {
            data: options.threads ?? [nativeThread(cwd)],
            nextCursor: options.nextCursor ?? null,
          };
        if (method === "thread/read") {
          options.afterRead?.();
          return { thread: options.readThread ?? nativeThread(cwd) };
        }
        throw new Error(`Unexpected native operation: ${method}`);
      }),
  } as unknown as CodexGateway["Service"];
  const workspace = {
    readNativeSessionBindings: () =>
      Effect.succeed(
        (options.durableThreads ?? [])
          .filter(
            (thread) =>
              thread.backendBinding.kind === "codex" && thread.executionHostId === "local",
          )
          .map((thread) => ({
            nativeSessionId: thread.threadId,
            threadId: thread.threadId,
            sessionId: thread.sessionId,
            projectId: thread.projectId,
          })),
      ),
    attachNativeSession: (
      input: Parameters<ProjectWorkspace["Service"]["attachNativeSession"]>[0],
    ) =>
      Effect.sync(() => {
        admissions.push(input);
        return result;
      }),
  } as unknown as ProjectWorkspace["Service"];
  const agents = {
    listClaudeNativeSessions: (input: NativeSessionCatalogInput) =>
      Effect.sync(() => {
        claudeLists.push(input);
        return options.claudePage ?? { nativeHome: home, entries: [], nextCursor: null };
      }),
    attachClaudeNativeSession: (input: NativeSessionAttachInput) =>
      Effect.sync(() => {
        claudeAttachments.push(input);
        return result;
      }),
  } as unknown as AgentBackendApplication["Service"];
  return {
    home,
    cwd,
    requests,
    admissions,
    claudeLists,
    claudeAttachments,
    setActiveHome: (next: string) => {
      activeHome = next;
    },
    catalog: make.pipe(
      Effect.provideService(AgentBackendApplication, agents),
      Effect.provideService(ApplicationSettings, settings),
      Effect.provideService(CodexGateway, gateway),
      Effect.provideService(ProjectWorkspace, workspace),
    ),
  };
};

it.effect("pages persistent Codex roots without loading history or starting a runtime", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const cwd = join(root, "workspace");
      const fixture = harness(root, {
        threads: [
          nativeThread(cwd),
          nativeThread(cwd, { id: "child", parentThreadId: SESSION_ID }),
          nativeThread(cwd, { id: "review", source: { subAgent: "review" } }),
          nativeThread(cwd, { id: "temporary", ephemeral: true }),
          nativeThread(cwd, { id: "runtime-chat", threadSource: "agent_runtime" }),
          nativeThread(cwd, {
            id: "runtime-import",
            threadSource: "agent_runtime:019d0000-0000-7000-8000-000000000002",
          }),
          nativeThread(join(root, "missing"), { id: "missing-workspace" }),
        ],
        durableThreads: [
          {
            threadId: SESSION_ID,
            sessionId: "existing-session",
            backendBinding: { kind: "codex" },
            executionHostId: "local",
          },
        ] as DesktopProjectWorkspaceThread[],
        nextCursor: "next-native-page",
      });
      const catalog = yield* fixture.catalog;
      const page = yield* catalog.list({ backendKind: "codex", cursor: "native-page" });
      assert.deepEqual(page, {
        nativeHome: fixture.home,
        entries: [
          {
            nativeSessionId: SESSION_ID,
            title: "CLI conversation",
            cwd,
            cwdAvailable: true,
            updatedAt: 20_000,
            attachedThreadId: SESSION_ID,
            attachedSessionId: "existing-session",
          },
          {
            nativeSessionId: "missing-workspace",
            title: "CLI conversation",
            cwd: join(root, "missing"),
            cwdAvailable: false,
            updatedAt: 20_000,
          },
        ],
        nextCursor: "next-native-page",
      });
      assert.deepEqual(
        fixture.requests.map(({ method }) => method),
        ["thread/list"],
      );
      assert.deepEqual(fixture.requests[0]?.params, {
        cursor: "native-page",
        limit: 50,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
        archived: false,
      });
      assert.equal(fixture.admissions.length, 0);
    }),
  ),
);

it.effect("previews a local thread link even when its original workspace is unavailable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const cwd = join(root, "missing-workspace");
      const fixture = harness(root, { readThread: nativeThread(cwd) });
      const alias = join(root, "native-alias");
      symlinkSync(fixture.home, alias, "dir");
      fixture.setActiveHome(alias);
      const catalog = yield* fixture.catalog;
      const preview = yield* catalog.previewCodexImport({
        reference: `codex://threads/${SESSION_ID.toUpperCase()}?hostId=local`,
      });
      assert.deepEqual(preview, {
        nativeSessionId: SESSION_ID,
        nativeHome: fixture.home,
        title: "CLI conversation",
        cwd,
        cwdAvailable: false,
        updatedAt: 20_000,
      });
      assert.deepEqual(fixture.requests, [
        { method: "thread/read", params: { threadId: SESSION_ID, includeTurns: false } },
      ]);
      assert.equal(fixture.admissions.length, 0);
    }),
  ),
);

it.effect("rejects remote and malformed import references before reading native history", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const fixture = harness(root);
      const catalog = yield* fixture.catalog;
      for (const reference of [
        `codex://threads/${SESSION_ID}?hostId=remote-ssh:work`,
        `codex://threads/${SESSION_ID}?hostId=local&hostId=remote`,
        `https://example.com/threads/${SESSION_ID}`,
        "codex://threads/not-a-thread",
      ]) {
        const failure = yield* catalog.previewCodexImport({ reference }).pipe(Effect.flip);
        assert.equal(failure.message, "Enter a local Codex thread link or ID.");
      }
      assert.equal(fixture.requests.length, 0);
      assert.equal(fixture.admissions.length, 0);
    }),
  ),
);

it.effect("prepares a missing-workspace import with an explicit existing replacement", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const sourceCwd = join(root, "missing-workspace");
      const fixture = harness(root, {
        readThread: nativeThread(sourceCwd, { model: "gpt-5.4" }),
      });
      const catalog = yield* fixture.catalog;
      const source = yield* catalog.prepareCodexImport(importInput(fixture.home, fixture.cwd));
      assert.deepEqual(source, {
        nativeSessionId: SESSION_ID,
        nativeHome: fixture.home,
        title: "CLI conversation",
        cwd: sourceCwd,
        cwdAvailable: false,
        updatedAt: 20_000,
        model: "gpt-5.4",
      });
      assert.deepEqual(fixture.requests, [
        { method: "thread/read", params: { threadId: SESSION_ID, includeTurns: false } },
      ]);
      assert.equal(fixture.admissions.length, 0);
    }),
  ),
);

it.effect("requires a real replacement directory before preparing an import", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const fixture = harness(root);
      const file = join(root, "workspace-file");
      writeFileSync(file, "not a directory");
      const catalog = yield* fixture.catalog;
      for (const cwd of ["", "relative-workspace", join(root, "missing"), file]) {
        const failure = yield* catalog
          .prepareCodexImport(importInput(fixture.home, cwd))
          .pipe(Effect.flip);
        assert.equal(
          failure.message,
          "Choose an existing working directory for the imported chat.",
        );
      }
      assert.equal(fixture.requests.length, 0);
      assert.equal(fixture.admissions.length, 0);
    }),
  ),
);

it.effect("rejects a stale import home before reading the source conversation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const fixture = harness(root);
      const catalog = yield* fixture.catalog;
      const failure = yield* catalog
        .prepareCodexImport(importInput(join(root, "previous-home"), fixture.cwd))
        .pipe(Effect.flip);
      assert.equal(failure.message, "The Codex account changed. Look up the conversation again.");
      assert.equal(fixture.requests.length, 0);
      assert.equal(fixture.admissions.length, 0);
    }),
  ),
);

it.effect.each(["preview", "prepare"] as const)(
  "rejects an account change during import %s metadata lookup",
  (operation) =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRoot;
        const otherHome = join(root, "other-home");
        mkdirSync(otherHome);
        const fixture = harness(root, { afterRead: () => fixture.setActiveHome(otherHome) });
        const catalog = yield* fixture.catalog;
        const inspection =
          operation === "preview"
            ? catalog.previewCodexImport({ reference: SESSION_ID })
            : catalog.prepareCodexImport(importInput(fixture.home, fixture.cwd));
        const failure = yield* inspection.pipe(Effect.flip);
        assert.equal(failure.message, "The Codex account changed. Look up the conversation again.");
        assert.deepEqual(fixture.requests, [
          { method: "thread/read", params: { threadId: SESSION_ID, includeTurns: false } },
        ]);
        assert.equal(fixture.admissions.length, 0);
      }),
    ),
);

it.effect.each([
  { parentThreadId: "parent" },
  { source: { subAgent: "compact" } },
  { ephemeral: true },
  { threadSource: "agent_runtime" },
  { threadSource: "agent_runtime:019d0000-0000-7000-8000-000000000002" },
  { id: "019d0000-0000-7000-8000-000000000003" },
] satisfies Partial<Thread>[])("rejects ineligible Codex import sources %#", (patch) =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const fixture = harness(root, {
        readThread: nativeThread(join(root, "workspace"), patch),
      });
      const catalog = yield* fixture.catalog;
      const previewFailure = yield* catalog
        .previewCodexImport({ reference: SESSION_ID })
        .pipe(Effect.flip);
      const prepareFailure = yield* catalog
        .prepareCodexImport(importInput(fixture.home, fixture.cwd))
        .pipe(Effect.flip);
      assert.equal(
        previewFailure.message,
        "Subagent and Nodex-run Codex conversations cannot be imported.",
      );
      assert.equal(prepareFailure.message, previewFailure.message);
      assert.deepEqual(fixture.requests, [
        { method: "thread/read", params: { threadId: SESSION_ID, includeTurns: false } },
        { method: "thread/read", params: { threadId: SESSION_ID, includeTurns: false } },
      ]);
      assert.equal(fixture.admissions.length, 0);
    }),
  ),
);

it.effect("admits the original native ID after an exact metadata-only read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const fixture = harness(root);
      const alias = join(root, "native-alias");
      symlinkSync(fixture.home, alias, "dir");
      fixture.setActiveHome(alias);
      const catalog = yield* fixture.catalog;
      const result = yield* catalog.attach({
        backendKind: "codex",
        nativeSessionId: SESSION_ID,
        expectedHome: fixture.home,
        projectId: "selected-project",
      });
      assert.equal(result.threadId, SESSION_ID);
      assert.deepEqual(fixture.requests, [
        { method: "thread/read", params: { threadId: SESSION_ID, includeTurns: false } },
      ]);
      assert.deepEqual(fixture.admissions, [
        {
          backendKind: "codex",
          nativeSessionId: SESSION_ID,
          nativeHome: fixture.home,
          projectId: "selected-project",
          title: "CLI conversation",
          cwd: fixture.cwd,
          createdAt: 10_000,
          updatedAt: 20_000,
        },
      ]);
    }),
  ),
);

it.effect(
  "bounds native titles without breaking Unicode or the original conversation identity",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRoot;
        const title = `${"x".repeat(1999)}🙂 trailing title`;
        const thread = nativeThread(join(root, "workspace"), { name: title });
        const fixture = harness(root, { threads: [thread], readThread: thread });
        const catalog = yield* fixture.catalog;
        const page = yield* catalog.list({ backendKind: "codex" });
        yield* catalog.attach({
          backendKind: "codex",
          nativeSessionId: SESSION_ID,
          expectedHome: fixture.home,
          projectId: null,
        });
        assert.equal(page.entries[0]?.title, "x".repeat(1999));
        assert.equal(fixture.admissions[0]?.title, page.entries[0]?.title);
        assert.equal(fixture.admissions[0]?.nativeSessionId, SESSION_ID);
      }),
    ),
);

it.effect("rejects a stale home before issuing native requests", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const fixture = harness(root);
      const catalog = yield* fixture.catalog;
      const result = yield* catalog
        .attach({
          backendKind: "codex",
          nativeSessionId: SESSION_ID,
          expectedHome: join(root, "previous-home"),
          projectId: null,
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(fixture.requests.length, 0);
      assert.equal(fixture.admissions.length, 0);
    }),
  ),
);

it.effect("revalidates the home after native metadata lookup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const otherHome = join(root, "other-home");
      mkdirSync(otherHome);
      const fixture = harness(root, { afterRead: () => fixture.setActiveHome(otherHome) });
      const catalog = yield* fixture.catalog;
      const result = yield* catalog
        .attach({
          backendKind: "codex",
          nativeSessionId: SESSION_ID,
          expectedHome: fixture.home,
          projectId: null,
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(fixture.requests.length, 1);
      assert.equal(fixture.admissions.length, 0);
    }),
  ),
);

it.effect(
  "refuses sidechains, transient sessions and missing native workspaces at attachment",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRoot;
        for (const patch of [
          { parentThreadId: "parent" },
          { source: { subAgent: "compact" } },
          { ephemeral: true },
          { cwd: join(root, "missing-workspace") },
          { id: "different-native-id" },
        ] as Partial<Thread>[]) {
          const fixture = harness(root, {
            readThread: nativeThread(join(root, "workspace"), patch),
          });
          const catalog = yield* fixture.catalog;
          const result = yield* catalog
            .attach({
              backendKind: "codex",
              nativeSessionId: SESSION_ID,
              expectedHome: fixture.home,
              projectId: null,
            })
            .pipe(Effect.result);
          assert.equal(result._tag, "Failure");
          assert.equal(fixture.admissions.length, 0);
        }
      }),
    ),
);

it.effect("uses the selected Claude instance through the same catalog interface", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const fixture = harness(root);
      const catalog = yield* fixture.catalog;
      const listInput = {
        backendKind: "claude" as const,
        instanceConfigId: "personal",
        cursor: "50",
      };
      const attachInput = {
        backendKind: "claude" as const,
        instanceConfigId: "personal",
        nativeSessionId: "claude-native-id",
        expectedHome: fixture.home,
        projectId: "selected-project",
      };
      yield* catalog.list(listInput);
      yield* catalog.attach(attachInput);
      assert.deepEqual(fixture.claudeLists, [listInput]);
      assert.deepEqual(fixture.claudeAttachments, [attachInput]);
      assert.equal(fixture.requests.length, 0);
      assert.equal(fixture.admissions.length, 0);
    }),
  ),
);
