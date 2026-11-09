import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as DateTime from "effect/DateTime";
import type { components } from "@nodex/core-protocol";
import type { AgentRuntimeLaunch } from "../../shared/agent-runtime-api";
import type { AgentRuntimeApplicationConnection } from "../agent-runtime/AgentRuntimeApplication";
import { CoreModules } from "../core-runtime/CoreModules";
import { createOperationId, createStableOperationId } from "../core-runtime/operation-identity";
import { CodexGitProbe } from "../codex-application/CodexGitProbe";
import { ManagedWorktreeRuntime } from "../codex-application/ManagedWorktreeRuntime";
import { ExecutionHostRuntime } from "../codex-application/ExecutionHostRuntime";
import {
  pageWorkspaceWorktreePath,
  resolveManagedWorktreeDefaultStartingState,
} from "../codex/git-worktree-service";
import { readGhPrStatus } from "../github-pr-service";
import { NativeSessionWorkspace } from "./NativeSessionWorkspace";

type Workspace = components["schemas"]["PageWorkspace"];
type Core = CoreModules["Service"];
export class PageWorkspaceError extends Schema.TaggedError<PageWorkspaceError>()(
  "PageWorkspaceError",
  { cause: Schema.Defect() },
) {}

export function canonicalRepositoryUrl(value: string | null): string | null {
  if (!value) return null;
  const remote = value.trim();
  const normalized = remote
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^ssh:\/\/(?:git@)?/, "https://")
    .replace(/^git:\/\//, "https://");
  try {
    const url = new URL(normalized);
    if (!["http:", "https:"].includes(url.protocol)) return url.href;
    const host = remote.startsWith("ssh://") ? url.hostname : url.host;
    return `https://${host.toLowerCase()}${url.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}
export function pageWorkspaceBranch(page: {
  pageId: string;
  pageKey: string | null;
  title: string;
}): string {
  const slug = page.title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/g, "");
  const key =
    page.pageKey?.toLowerCase().replace(/[^a-z0-9-]/g, "") ||
    createHash("sha256").update(page.pageId).digest("hex").slice(0, 8);
  return slug ? `${key}-${slug}` : key;
}
export const workspaceWindow = Effect.fn("PageWorkspaceApplication.window")(function* (core: Core) {
  const values: Workspace[] = [];
  let cursor: string | null = null;
  while (true) {
    const read: import("../core-client/types").ProjectWorkspaceReadSnapshot =
      yield* core.workspace.read(
        { kind: "page_workspace_window", after_workspace_id: cursor, limit: 100 },
        undefined,
        null,
      );
    if (read.value.kind !== "page_workspace_window")
      return yield* new PageWorkspaceError({ cause: new Error("Invalid Workspace window") });
    values.push(...read.value.workspaces);
    if (read.value.workspaces.length < 100) return values;
    cursor = read.value.workspaces.at(-1)!.workspace_id;
  }
});
export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const git = yield* CodexGitProbe;
  const hosts = yield* ExecutionHostRuntime;
  const native = yield* NativeSessionWorkspace;
  const worktrees = yield* ManagedWorktreeRuntime;
  // Allocation and cleanup share the gate; durable claims survive this process.
  const lane = yield* Semaphore.make(1);
  const readPage = Effect.fn("PageWorkspaceApplication.readPage")(function* (pageId: string) {
    const read = yield* core.workspace.read(
      { kind: "page_workspace", page_id: pageId },
      undefined,
      null,
    );
    if (read.value.kind !== "page_workspace")
      return yield* new PageWorkspaceError({ cause: new Error("Invalid Page Workspace") });
    return read.value;
  });
  const apply = (
    intent: components["schemas"]["ProjectWorkspaceIntent"],
    operationId = createOperationId("page-workspace"),
  ) => core.workspace.apply({ operationId, intent }, undefined, null);
  const ensure = Effect.fn("PageWorkspaceApplication.ensure")(function* (input: {
    launch: AgentRuntimeLaunch;
    sourceCwd: string;
    sourceRoots: readonly string[];
  }) {
    const launch = input.launch;
    if (!launch.projectId || !launch.workPage) return null;
    const root = yield* git.readPath(input.sourceCwd, ["rev-parse", "--show-toplevel"]);
    if (!root) {
      if (yield* git.isNonGitWorkspace(input.sourceCwd)) return null;
      return yield* new PageWorkspaceError({
        cause: new Error("Project repository is unavailable"),
      });
    }
    const observation = yield* readPage(launch.workPage.pageId);
    if (launch.workPage.onlyIfAgentWork && !observation.has_agent_work) return null;
    const page = observation.page;
    const origin = yield* git.readPath(root, ["remote", "get-url", "origin"]);
    const fallback = origin
      ? null
      : (yield* git.readPath(root, ["remote"]))?.split(/\r?\n/).find(Boolean);
    const repository = canonicalRepositoryUrl(
      origin ?? (fallback ? yield* git.readPath(root, ["remote", "get-url", fallback]) : null),
    );
    const known = observation.workspace;
    if (known && (known.repository_root !== root || known.repository_url !== repository))
      return yield* new PageWorkspaceError({
        cause: new Error("Page Workspace belongs to another repository"),
      });
    const base =
      known?.base_commit_oid ??
      (yield* Effect.tryPromise({
        try: () =>
          resolveManagedWorktreeDefaultStartingState(root).then((state) => state.branchName),
        catch: (cause) => new PageWorkspaceError({ cause }),
      }).pipe(
        Effect.flatMap((ref) => git.readPath(root, ["rev-parse", "--verify", `${ref}^{commit}`])),
      ));
    if (!base)
      return yield* new PageWorkspaceError({ cause: new Error("Default branch has no commit") });
    const workspaceId = known?.workspace_id ?? `page-workspace:${page.page_id}`;
    if (known && ["preparing", "ready"].includes(known.lifecycle)) {
      yield* apply({
        kind: "bind_page_workspace",
        workspace_id: known.workspace_id,
        session_id: launch.sessionId,
      });
    } else {
      const host = yield* hosts.resolve("local", "create");
      yield* apply(
        {
          kind: "claim_page_workspace",
          workspace_id: workspaceId,
          page_id: page.page_id,
          project_id: launch.projectId,
          session_id: launch.sessionId,
          repository_url: repository,
          repository_root: root,
          branch_name:
            known?.branch_name ??
            pageWorkspaceBranch({
              pageId: page.page_id,
              pageKey: page.page_key ?? null,
              title: page.title,
            }),
          base_commit_oid: base,
          worktree_path: pageWorkspaceWorktreePath(host.descriptor.managedRoot, root, workspaceId),
        },
        createStableOperationId("page-workspace.claim", launch.acceptedAt, {
          launchId: launch.launchId,
          pageId: page.page_id,
          revision: known?.revision ?? 0,
        }),
      );
    }
    const claimed = (yield* readPage(page.page_id)).workspace!;
    if (claimed.lifecycle === "ready" && claimed.worktree_path) {
      const lease = yield* native.prepare({
        projectId: launch.projectId,
        targetId: launch.sessionId,
        title: page.title,
        prompt: launch.message.text,
        sourceCwd: input.sourceCwd,
        sourceRoots: input.sourceRoots,
        runInTarget: "localProject",
        operationId: claimed.allocation_operation_id,
        reusePageWorkspace: {
          worktreeGitRoot: claimed.worktree_path,
          branchName: claimed.branch_name,
        },
      });
      return {
        ...lease,
        attach: (threadId: string) =>
          native.reconcile({ cwd: lease.location.cwd, threadId, sharedWorkspace: true }),
      };
    }
    if (claimed.lifecycle !== "preparing")
      return yield* new PageWorkspaceError({ cause: new Error("Page Workspace is unavailable") });
    const lease = yield* native
      .prepare({
        projectId: launch.projectId,
        targetId: launch.sessionId,
        title: page.title,
        prompt: launch.message.text,
        sourceCwd: root,
        sourceRoots: input.sourceRoots,
        runInTarget: "newWorktree",
        operationId: claimed.allocation_operation_id,
        pageWorkspace: {
          workspaceId: claimed.workspace_id,
          operationId: claimed.allocation_operation_id,
          branchName: claimed.branch_name,
          baseCommitOid: claimed.base_commit_oid,
        },
      })
      .pipe(
        Effect.tapError((cause) =>
          apply({
            kind: "record_page_workspace_failed",
            workspace_id: claimed.workspace_id,
            allocation_operation_id: claimed.allocation_operation_id,
            failure: String(cause).slice(0, 4096) || "Workspace preparation failed",
          }).pipe(Effect.ignore),
        ),
      );
    if (!lease.branchName || !lease.location.managedWorktreePath)
      return yield* new PageWorkspaceError({
        cause: new Error("Page Workspace branch is unavailable"),
      });
    yield* apply({
      kind: "record_page_workspace_ready",
      workspace_id: claimed.workspace_id,
      allocation_operation_id: claimed.allocation_operation_id,
      branch_name: lease.branchName,
      worktree_path: lease.location.managedWorktreePath,
    });
    if ((yield* readPage(page.page_id)).workspace?.lifecycle !== "ready")
      return yield* new PageWorkspaceError({
        cause: new Error("Page Workspace is awaiting cleanup"),
      });
    return lease;
  });
  const consumers = Effect.fn("PageWorkspaceApplication.consumers")(function* (
    workspace: Workspace,
  ) {
    const ids: string[] = [];
    let cursor: string | null = null;
    while (true) {
      const read: import("../core-client/types").ProjectWorkspaceReadSnapshot =
        yield* core.workspace.read(
          {
            kind: "page_workspace_consumers",
            workspace_id: workspace.workspace_id,
            after_session_id: cursor,
            limit: 100,
          },
          undefined,
          null,
        );
      if (read.value.kind !== "page_workspace_consumers")
        return yield* new PageWorkspaceError({
          cause: new Error("Workspace consumers are unavailable"),
        });
      ids.push(...read.value.session_ids);
      if (read.value.session_ids.length < 100) return ids;
      cursor = read.value.session_ids.at(-1)!;
    }
  });
  const refreshPr = Effect.fn("PageWorkspaceApplication.refreshPr")(function* (
    workspace: Workspace,
  ) {
    if (!workspace.repository_url || !workspace.worktree_path) return;
    const pr = yield* Effect.tryPromise({
      try: () =>
        readGhPrStatus({ cwd: workspace.worktree_path!, headBranch: workspace.branch_name }),
      catch: (cause) => new PageWorkspaceError({ cause }),
    });
    if (
      pr.status !== "ready" ||
      !pr.prNumber ||
      !pr.url ||
      !pr.state ||
      pr.headBranch !== workspace.branch_name ||
      canonicalRepositoryUrl(pr.headRepositoryUrl ?? null) !== workspace.repository_url
    )
      return;
    yield* apply({
      kind: "upsert_page_pull_request",
      workspace_id: workspace.workspace_id,
      head_branch: pr.headBranch,
      repository: workspace.repository_url,
      number: pr.prNumber,
      url: pr.url,
      state: pr.state,
      observed_at: DateTime.formatIso(yield* DateTime.now),
    });
  });
  const reconcile = Effect.fn("PageWorkspaceApplication.reconcile")(function* (
    connection: AgentRuntimeApplicationConnection | null,
  ) {
    const values = yield* workspaceWindow(core);
    for (const value of values) {
      if (value.lifecycle === "preparing") {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const page = (yield* readPage(value.page_id)).page;
            const lease = yield* native.prepare({
              projectId: value.project_id,
              targetId: value.workspace_id,
              title: page.title,
              prompt: "",
              sourceCwd: value.repository_root,
              sourceRoots: [value.repository_root],
              runInTarget: "newWorktree",
              operationId: value.allocation_operation_id,
              pageWorkspacePath: value.worktree_path!,
              pageWorkspace: {
                workspaceId: value.workspace_id,
                operationId: value.allocation_operation_id,
                branchName: value.branch_name,
                baseCommitOid: value.base_commit_oid,
              },
            });
            if (!lease.branchName || !lease.location.managedWorktreePath)
              return yield* new PageWorkspaceError({
                cause: new Error("Workspace recovery has no branch"),
              });
            yield* apply({
              kind: "record_page_workspace_ready",
              workspace_id: value.workspace_id,
              allocation_operation_id: value.allocation_operation_id,
              branch_name: lease.branchName,
              worktree_path: lease.location.managedWorktreePath,
            });
            yield* worktrees.releaseNewborn({
              hostId: "local",
              worktreeGitRoot: lease.location.managedWorktreePath,
            });
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Page Workspace preparation awaits retry").pipe(
              Effect.annotateLogs({ workspaceId: value.workspace_id, cause }),
            ),
          ),
        );
      }

      if (value.lifecycle !== "cleanup_requested" || !connection || !value.worktree_path) continue;
      const bindings = yield* Effect.forEach(yield* consumers(value), (sessionId) =>
        core.workspace.read(
          { kind: "agent_runtime_session_binding", session_id: sessionId },
          undefined,
          null,
        ),
      );
      const threads = bindings.map((read) =>
        read.value.kind === "agent_runtime_session_binding" ? read.value.binding : null,
      );
      if (
        threads.some((binding) => !binding || binding.runtime_id !== connection.identity.runtimeId)
      )
        continue;
      const ids = threads.map((binding) => binding!.runtime_thread_id);
      const busy = Effect.gen(function* () {
        for (let offset = 0; offset < ids.length; offset += 100) {
          const activity = yield* connection.request("execution.activity", {
            rootThreadIds: ids.slice(offset, offset + 100),
            limit: 100,
          });
          if (activity.items.length > 0) return true;
        }
        for (const threadId of ids) {
          const thread = yield* connection.request("thread.read", { threadId });
          if (
            !thread ||
            thread.activeRunId !== null ||
            (thread.pendingBackgroundTasks?.length ?? 0) > 0
          )
            return true;
        }
        return false;
      });
      if (yield* busy) continue;
      const operationId = `page-workspace-cleanup:${value.workspace_id}:${value.revision}`;
      yield* Effect.scoped(
        Effect.gen(function* () {
          for (const threadId of ids) {
            const thread = yield* connection.request("thread.read", { threadId });
            if (!thread?.worktreePath) return;
            // Seal each consumer where Runtime actually owns it, including a moved
            // or nested cwd. Deletion still names only the Page's physical checkout.
            yield* Effect.acquireRelease(
              connection.request("execution.handoff.hold", {
                threadId,
                operationId,
                action: "acquire",
                sourceLocation: thread.executionLocation ?? {
                  hostId: "local",
                  cwd: thread.worktreePath,
                  workspaceRoots: [thread.worktreePath],
                  managedWorktreePath: null,
                  projectId: value.project_id,
                  projectlessOutputDirectory: null,
                  projectlessWorkspaceBrowserRoot: null,
                },
              }),
              () =>
                connection
                  .request("execution.handoff.hold", { threadId, operationId, action: "release" })
                  .pipe(Effect.ignore),
            );
          }
          if (yield* busy) return;
          const current = (yield* readPage(value.page_id)).workspace;
          if (current?.lifecycle !== "cleanup_requested" || current.revision !== value.revision)
            return;
          // Quiescence retires idle native sessions and tools before the final consumer check.
          for (const threadId of ids)
            yield* connection.request("execution.handoff.quiesce", { threadId, operationId });
          if (yield* busy) return;
          yield* worktrees.remove({
            hostId: "local",
            worktreeGitRoot: value.worktree_path!,
            reason: "page-completed",
          });
          yield* apply({
            kind: "mark_page_workspace_removed",
            workspace_id: value.workspace_id,
            expected_revision: value.revision,
          });
        }),
      );
    }
  });
  const threadsAtPath = Effect.fn("PageWorkspaceApplication.threadsAtPath")(function* (
    worktreePath: string,
  ) {
    const value = (yield* workspaceWindow(core)).find(
      (workspace) => workspace.worktree_path === worktreePath,
    );
    if (!value) return [];
    return yield* Effect.forEach(yield* consumers(value), (sessionId) =>
      core.workspace
        .read({ kind: "agent_runtime_session_binding", session_id: sessionId }, undefined, null)
        .pipe(
          Effect.flatMap((read) =>
            read.value.kind === "agent_runtime_session_binding" && read.value.binding
              ? Effect.succeed(read.value.binding.runtime_thread_id)
              : Effect.fail(
                  new PageWorkspaceError({
                    cause: new Error("Workspace consumer execution is unavailable"),
                  }),
                ),
          ),
        ),
    );
  });
  const observedRuns = new Map<string, string>();
  const observePrs = Effect.fn("PageWorkspaceApplication.observePrs")(function* (
    connection: AgentRuntimeApplicationConnection | null,
  ) {
    if (!connection) return;
    for (const workspace of yield* workspaceWindow(core)) {
      if (workspace.lifecycle !== "ready") continue;
      const ids = yield* threadsAtPath(workspace.worktree_path!);
      const threads = yield* Effect.forEach(ids, (threadId) =>
        connection.request("thread.read", { threadId }),
      );
      const settled = threads.filter((thread) => thread && thread.activeRunId === null);
      if (settled.length === 0) continue;
      const signature = settled
        .map((thread) => `${thread!.id}:${thread!.latestRunId ?? ""}`)
        .join("|");
      if (observedRuns.get(workspace.workspace_id) === signature) continue;
      yield* refreshPr(workspace).pipe(
        Effect.tap(() => Effect.sync(() => observedRuns.set(workspace.workspace_id, signature))),
        Effect.ignore,
      );
    }
  });
  return {
    cleanupPending: workspaceWindow(core).pipe(
      Effect.map((values) => values.some((value) => value.lifecycle === "cleanup_requested")),
    ),
    threadsAtPath,
    ensure: (input: Parameters<typeof ensure>[0]) => lane.withPermits(1)(ensure(input)),
    reconcile: (connection: AgentRuntimeApplicationConnection | null) =>
      lane
        .withPermits(1)(reconcile(connection))
        .pipe(Effect.andThen(observePrs(connection))),
    refresh: (pageId: string) =>
      readPage(pageId).pipe(
        Effect.flatMap((value) => (value.workspace ? refreshPr(value.workspace) : Effect.void)),
      ),
  };
});
export type PageWorkspaceApplication = Effect.Success<typeof make>;
