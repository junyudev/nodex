import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { fileURLToPath } from "node:url";
import { acquireAgentRuntimeProcess } from "../platform/node/AgentRuntimeProcess";
import { expect, vi, test } from "vite-plus/test";
import { it } from "@effect/vitest";
import type { components } from "@nodex/core-protocol";
import type { AgentRuntimeLaunch } from "../../shared/agent-runtime-api";
import { CoreModules } from "../core-runtime/CoreModules";
import { CodexGitProbe, make as makeGitProbe } from "../codex-application/CodexGitProbe";
import { ExecutionHostRuntime } from "../codex-application/ExecutionHostRuntime";
import { ManagedWorktreeRuntime } from "../codex-application/ManagedWorktreeRuntime";
import { createManagedWorktree, removeManagedWorktree } from "../codex/git-worktree-service";
import { NativeSessionWorkspace } from "./NativeSessionWorkspace";
import { make, pageWorkspaceBranch, canonicalRepositoryUrl } from "./PageWorkspaceApplication";
import type { AgentRuntimeApplicationConnection } from "../agent-runtime/AgentRuntimeApplication";
const forge = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../github-pr-service", () => ({ readGhPrStatus: forge.read }));
const exec = promisify(execFile);
const launch: AgentRuntimeLaunch = {
  launchId: "launch",
  acceptedAt: 1,
  projectId: "project",
  sessionId: "one",
  title: "Task",
  modelSelection: { instanceId: "codex", model: "test" },
  interactionMode: "default",
  workPage: { pageId: "page" },
  message: { messageId: "message", text: "Work" },
};

async function fixture(gitRepository = true) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "nodex-page-workspace-")));
  const repository = join(home, "repo");
  await mkdir(repository);
  if (gitRepository) {
    await writeFile(join(repository, "readme"), "base");
  }
  let workspace: components["schemas"]["PageWorkspace"] | null = null;
  let pullRequest: unknown = null;
  const consumers = new Set<string>();
  const events: string[] = [];
  const busy = new Set<string>();
  const held = new Set<string>();
  let afterHold = false;
  let creations = 0;
  let loseReady = false;
  let hasAgentAssignee = true;
  const core = {
    workspace: {
      read: (input: { kind: string; page_id?: string; session_id?: string }) =>
        Effect.sync(() => ({
          value:
            input.kind === "page_workspace_window"
              ? { kind: input.kind, workspaces: workspace ? [workspace] : [] }
              : input.kind === "page_workspace_consumers"
                ? { kind: input.kind, session_ids: [...consumers] }
                : input.kind === "agent_runtime_session_binding"
                  ? {
                      kind: input.kind,
                      binding: { runtime_id: "runtime", runtime_thread_id: input.session_id },
                    }
                  : {
                      kind: "page_workspace",
                      workspace,
                      pull_request: pullRequest,
                      page: {
                        page_id: "page",
                        page_key: "NODEX-12",
                        title: "Fix login",
                        status: "doing",
                      },
                      has_agent_work: hasAgentAssignee,
                    },
        })),
      apply: (input: { operationId: string; intent: Record<string, unknown> }) =>
        Effect.sync(() => {
          const intent = input.intent;
          events.push(String(intent.kind));
          if (intent.kind === "claim_page_workspace") {
            workspace = {
              ...intent,
              allocation_operation_id: input.operationId,
              lifecycle: "preparing",
              revision: 1,
              failure: null,
            } as unknown as components["schemas"]["PageWorkspace"];
            consumers.add(String(intent.session_id));
          }
          if (intent.kind === "bind_page_workspace") consumers.add(String(intent.session_id));
          if (intent.kind === "record_page_workspace_ready" && loseReady) {
            loseReady = false;
            throw new Error("Main ended before ready committed");
          }
          if (intent.kind === "record_page_workspace_ready" && workspace)
            workspace = {
              ...workspace,
              lifecycle: "ready",
              branch_name: String(intent.branch_name),
              worktree_path: String(intent.worktree_path),
              revision: workspace.revision + 1,
            };
          if (intent.kind === "mark_page_workspace_removed" && workspace)
            workspace = {
              ...workspace,
              lifecycle: "removed",
              worktree_path: null,
              revision: workspace.revision + 1,
            };
          if (intent.kind === "upsert_page_pull_request") pullRequest = intent;
          return {};
        }),
    },
  };
  const git = makeGitProbe({ environment: process.env });
  const owner = make.pipe(
    Effect.provideService(CoreModules, core as never),
    Effect.provideService(CodexGitProbe, git),
    Effect.provideService(ExecutionHostRuntime, {
      resolve: () => Effect.succeed({ descriptor: { managedRoot: join(home, "trees") } }),
    } as never),
    Effect.provideService(NativeSessionWorkspace, {
      prepare: (input) =>
        Effect.tryPromise(async () => {
          if (input.reusePageWorkspace)
            return {
              branchName: input.reusePageWorkspace.branchName,
              location: {
                cwd: input.reusePageWorkspace.worktreeGitRoot,
                workspaceRoots: [input.reusePageWorkspace.worktreeGitRoot],
                managedWorktreePath: input.reusePageWorkspace.worktreeGitRoot,
                projectlessOutputDirectory: null,
                projectlessWorkspaceBrowserRoot: null,
              },
              retain: Effect.void,
              attach: () => Effect.void,
            };
          expect(workspace?.lifecycle).toBe("preparing");
          creations++;
          const result = await createManagedWorktree({
            repositoryPath: repository,
            nodexHome: home,
            managedRoot: join(home, "trees"),
            projectId: "project",
            targetId: input.targetId,
            threadTitle: input.title,
            mode: "detachedHead",
            pageWorkspace: input.pageWorkspace,
          });
          return {
            branchName: result.branchName,
            location: {
              cwd: result.worktreeGitRoot,
              workspaceRoots: [result.worktreeGitRoot],
              managedWorktreePath: result.worktreeGitRoot,
              projectlessOutputDirectory: null,
              projectlessWorkspaceBrowserRoot: null,
            },
            retain: Effect.void,
            attach: () => Effect.void,
          };
        }) as never,
      reconcile: () => Effect.void,
      environment: () => Effect.succeed(null),
    }),
    Effect.provideService(ManagedWorktreeRuntime, {
      releaseNewborn: () => Effect.void,
      remove: (
        input: import("../codex-application/ManagedWorktreeRuntime").ManagedWorktreeRemoveInput,
      ) =>
        Effect.tryPromise(async () => {
          expect([...consumers].every((id) => held.has(id))).toBe(true);
          expect(input.reason).toBe("page-completed");
          events.push("remove");
          await removeManagedWorktree(input.worktreeGitRoot);
          return {};
        }),
    } as never),
  );
  const connection = {
    identity: { runtimeId: "runtime" },
    request: (
      method: string,
      input: { threadId?: string; action?: string; rootThreadIds?: string[] },
    ) =>
      Effect.sync(() => {
        if (method === "execution.activity")
          return {
            items: (input.rootThreadIds ?? [])
              .filter((id) => busy.has(id))
              .map((rootThreadId) => ({ rootThreadId })),
            nextCursor: null,
          };
        if (method === "thread.read")
          return {
            id: input.threadId,
            latestRunId: `run:${input.threadId}`,
            activeRunId: busy.has(input.threadId!) ? "run" : null,
            pendingBackgroundTasks: [],
          };
        if (method === "execution.handoff.hold") {
          if (input.action === "acquire") {
            held.add(input.threadId!);
            if (afterHold) busy.add("two");
          } else held.delete(input.threadId!);
        }
        return null;
      }),
  } as unknown as AgentRuntimeApplicationConnection;
  forge.read.mockResolvedValue({ status: "disabled" });
  return {
    home,
    repository,
    owner,
    events,
    busy,
    connection,
    get workspace() {
      return workspace;
    },
    get pr() {
      return pullRequest;
    },
    get creations() {
      return creations;
    },
    ensure: (
      application: Effect.Success<typeof make>,
      sessionId = "one",
      onlyIfAgentWork = false,
    ) =>
      application.ensure({
        launch: { ...launch, sessionId, workPage: { pageId: "page", onlyIfAgentWork } },
        sourceCwd: repository,
        sourceRoots: [repository],
      }),
    assignAgent: (assigned: boolean) => {
      hasAgentAssignee = assigned;
    },
    loseReady: () => {
      loseReady = true;
    },
    cleanup: () => {
      workspace = {
        ...workspace!,
        lifecycle: "cleanup_requested",
        revision: workspace!.revision + 1,
      };
    },
    race: () => {
      afterHold = true;
    },
    dispose: () => rm(home, { recursive: true, force: true }),
  };
}

const acquireFixture = (gitRepository = true) =>
  Effect.acquireRelease(
    Effect.tryPromise(() => fixture(gitRepository)),
    (f) => Effect.promise(f.dispose),
  );

// Include the Runtime's 45s startup bound as well as real Git setup and cleanup.
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* acquireFixture();
        const owner = yield* f.owner;
        const lease = yield* f.ensure(owner);
        const cwd = lease!.location.cwd;
        const runtime = yield* acquireAgentRuntimeProcess({
          executable: process.execPath,
          entryPath: fileURLToPath(
            new URL("../../../packages/agent-runtime/src/nodex/entry.ts", import.meta.url),
          ),
          environment: { ...process.env, NODE_OPTIONS: `--import=${import.meta.resolve("tsx")}` },
          configuration: { home: f.home, cwd: f.repository, providers: {} },
          host: () => Effect.die("Cleanup must not start native work"),
        });
        yield* runtime.request("command.dispatch", {
          command: {
            type: "thread.create",
            commandId: "create:cleanup",
            threadId: "one",
            projectId: "project",
            title: "Finished Page",
            modelSelection: { instanceId: "codex", model: "test" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: f.workspace!.branch_name,
            createdBy: "user",
            creationSource: "web",
          },
        });
        const connection = {
          ...f.connection,
          request: (...args: Parameters<typeof runtime.request>) =>
            runtime
              .request(...args)
              .pipe(
                Effect.tap(() =>
                  args[0] === "execution.handoff.hold"
                    ? f.connection.request("execution.handoff.hold", args[1] as never)
                    : Effect.void,
                ),
              ),
        } as AgentRuntimeApplicationConnection;
        f.cleanup();
        yield* owner.reconcile(connection);
        yield* owner.reconcile(connection);
        expect(f.workspace?.lifecycle).toBe("removed");
        expect(f.events.filter((event) => event === "remove")).toHaveLength(1);
        expect(
          (yield* runtime.request("thread.read", { threadId: "one" }))?.executionHandoff,
        ).toBeNull();
        const trees = yield* Effect.promise(() =>
          exec("git", ["worktree", "list", "--porcelain"], { cwd: f.repository }),
        );
        expect(trees.stdout).not.toContain(cwd);
        yield* Effect.promise(() =>
          exec("git", ["show-ref", "--verify", `refs/heads/${f.workspace!.branch_name}`], {
            cwd: f.repository,
          }),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);
it.effect(
  "allocates once for a Page, binds a second chat, and protects every active consumer",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* acquireFixture();
        const owner = yield* f.owner;
        const first = yield* f.ensure(owner);
        const second = yield* f.ensure(owner, "two");
        expect(second?.location.cwd).toBe(first?.location.cwd);
        expect(f.creations).toBe(1);
        f.cleanup();
        f.busy.add("two");
        yield* owner.reconcile(f.connection);
        expect(f.events).not.toContain("remove");
        f.busy.clear();
        yield* owner.reconcile(f.connection);
        expect(f.events).toContain("remove");
        expect(f.workspace?.lifecycle).toBe("removed");
      }),
    ),
);
it.effect("rechecks all consumers after sealing execution", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* acquireFixture();
      const owner = yield* f.owner;
      yield* f.ensure(owner);
      yield* f.ensure(owner, "two");
      f.cleanup();
      f.race();
      yield* owner.reconcile(f.connection);
      expect(f.events).not.toContain("remove");
    }),
  ),
);
it.effect("keeps non-git Projects local", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* acquireFixture(false);
      const owner = yield* f.owner;
      expect(yield* f.ensure(owner)).toBeNull();
      expect(f.creations).toBe(0);
      expect(f.workspace).toBeNull();
    }),
  ),
);
it.effect(
  "links only a PR from the Workspace head repository and branch, retaining it through failures",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* acquireFixture();
        const owner = yield* f.owner;
        yield* f.ensure(owner);
        const pr = {
          status: "ready",
          prNumber: 42,
          url: "https://github.com/acme/repo/pull/42",
          state: "OPEN",
          headBranch: f.workspace!.branch_name,
          headRepositoryUrl: "https://github.com/acme/repo",
        };
        forge.read.mockResolvedValue({ ...pr, headBranch: "another" });
        yield* owner.refresh("page");
        expect(f.pr).toBeNull();
        forge.read.mockResolvedValue({ ...pr, headRepositoryUrl: "https://github.com/other/repo" });
        yield* owner.refresh("page");
        expect(f.pr).toBeNull();
        forge.read.mockResolvedValue(pr);
        yield* owner.refresh("page");
        expect(f.pr).toMatchObject({ number: 42 });
        forge.read.mockResolvedValue({ status: "error" });
        yield* owner.refresh("page");
        expect(f.pr).toMatchObject({ number: 42 });
      }),
    ),
);
test("uses a bounded readable branch stem and canonical forge identity", () => {
  expect(canonicalRepositoryUrl("file:///repositories/repo.git")).toBe(
    "file:///repositories/repo.git",
  );
  expect(canonicalRepositoryUrl("git://github.com/acme/repo.git")).toBe(
    "https://github.com/acme/repo",
  );
  expect(pageWorkspaceBranch({ pageId: "page", pageKey: "NODEX-12", title: "Fix Login!" })).toBe(
    "nodex-12-fix-login",
  );
  expect(pageWorkspaceBranch({ pageId: "019d0000-abcd", pageKey: null, title: "" })).toMatch(
    /^[a-z0-9]{8}$/,
  );
  expect(canonicalRepositoryUrl("git@github.com:acme/repo.git")).toBe(
    "https://github.com/acme/repo",
  );
});

it.effect("reconciles interrupted preparation with the retained allocation after restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* acquireFixture();
      const owner = yield* f.owner;
      f.loseReady();
      const interrupted = yield* Effect.exit(f.ensure(owner));
      expect(interrupted._tag).toBe("Failure");
      const retained = f.workspace!;
      expect(retained.lifecycle).toBe("preparing");
      const restarted = yield* f.owner;
      yield* restarted.reconcile(null);
      expect(f.workspace?.lifecycle).toBe("ready");
      expect(f.workspace?.allocation_operation_id).toBe(retained.allocation_operation_id);
      expect(f.workspace?.worktree_path).toBe(retained.worktree_path);
      const next = yield* f.ensure(restarted, "two");
      expect(next?.location.cwd).toBe(retained.worktree_path);
    }),
  ),
);

it.effect("records repository identity when the primary remote is not named origin", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* acquireFixture();
      yield* Effect.tryPromise(() =>
        exec("git", ["remote", "rename", "origin", "upstream"], { cwd: f.repository }),
      );
      const owner = yield* f.owner;
      yield* f.ensure(owner);
      expect(f.workspace?.repository_url).toBe("https://github.com/acme/repo");
    }),
  ),
);

it.effect("observes a completed Run's PR while another consumer is working", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* acquireFixture();
      const owner = yield* f.owner;
      yield* f.ensure(owner);
      yield* f.ensure(owner, "two");
      f.busy.add("two");
      forge.read.mockResolvedValue({
        status: "ready",
        prNumber: 42,
        url: "https://github.com/acme/repo/pull/42",
        state: "OPEN",
        headBranch: f.workspace!.branch_name,
        headRepositoryUrl: "https://github.com/acme/repo",
      });
      yield* owner.reconcile(f.connection);
      expect(f.pr).toMatchObject({ number: 42 });
    }),
  ),
);

it.effect("opens Pages in a chat Workspace only while they have an Agent Assignee", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* acquireFixture();
      const owner = yield* f.owner;
      f.assignAgent(false);
      expect(yield* f.ensure(owner, "one", true)).toBeNull();
      expect(f.creations).toBe(0);
      expect(f.workspace).toBeNull();
      f.assignAgent(true);
      expect(yield* f.ensure(owner, "one", true)).not.toBeNull();
      expect(f.creations).toBe(1);
    }),
  ),
);
