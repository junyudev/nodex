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
import { pageWorkspaceWorktreePath } from "../codex/codex-managed-worktree-allocation";
import { resolveManagedWorktreeDefaultStartingState } from "../codex/git-worktree-service";
import { readGhPrStatus } from "../github-pr-service";
import { readActionableErrorMessage } from "../actionable-error-message";
import { NativeSessionWorkspace } from "./NativeSessionWorkspace";

type Workspace = components["schemas"]["PageWorkspace"];
type Core = CoreModules["Service"];
export class PageWorkspaceError extends Schema.TaggedError<PageWorkspaceError>()(
  "PageWorkspaceError",
  { cause: Schema.Defect() },
) {}

/** A chat that works a Page, as the Page's Workspace needs to know it. */
export interface PageWorkspaceConsumer {
  readonly sessionId: string;
  readonly projectId: string | null;
  /** Where the chat would run without a Workspace: its repository, and its directory inside it. */
  readonly sourceCwd: string;
  readonly sourceRoots: readonly string[];
}

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
  // Checkout creation and cleanup share the gate. Claims are Core writes that survive this
  // process and never wait on it.
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
  /**
   * Joins a chat to its Page's Workspace, recording the intended checkout when the Page has none
   * to use. Git reads and one Core write: nothing is created on disk.
   */
  const join = Effect.fn("PageWorkspaceApplication.join")(function* (
    consumer: PageWorkspaceConsumer,
    target: NonNullable<AgentRuntimeLaunch["workPage"]>,
    launch?: Pick<AgentRuntimeLaunch, "launchId" | "acceptedAt">,
  ) {
    const projectId = consumer.projectId;
    if (!projectId) return null;
    const root = yield* git.readPath(consumer.sourceCwd, ["rev-parse", "--show-toplevel"]);
    if (!root) {
      if (yield* git.isNonGitWorkspace(consumer.sourceCwd)) return null;
      return yield* new PageWorkspaceError({
        cause: new Error("Project repository is unavailable"),
      });
    }
    const observation = yield* readPage(target.pageId);
    if (target.onlyIfAgentWork && !observation.has_agent_work) return null;
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
        session_id: consumer.sessionId,
      });
    } else {
      const host = yield* hosts.resolve("local", "create");
      yield* apply(
        {
          kind: "claim_page_workspace",
          workspace_id: workspaceId,
          page_id: page.page_id,
          project_id: projectId,
          session_id: consumer.sessionId,
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
          worktree_path:
            known?.worktree_path ??
            pageWorkspaceWorktreePath(host.descriptor.managedRoot, root, workspaceId),
        },
        // A repeated launch claims once; a later preparation of the same Workspace claims anew.
        launch
          ? createStableOperationId("page-workspace.claim", launch.acceptedAt, {
              launchId: launch.launchId,
              pageId: page.page_id,
              revision: known?.revision ?? 0,
            })
          : undefined,
      );
    }
    const claimed = (yield* readPage(page.page_id)).workspace!;
    return { projectId, title: page.title, workspace: claimed };
  });
  type Joined = NonNullable<Effect.Success<ReturnType<typeof join>>>;
  /** Every chat of a Page works in the Page's one checkout, at its own directory inside it. */
  const lease = Effect.fn("PageWorkspaceApplication.lease")(function* (
    consumer: PageWorkspaceConsumer,
    joined: Joined,
    worktreeGitRoot: string,
  ) {
    const shared = yield* native.prepare({
      projectId: joined.projectId,
      targetId: consumer.sessionId,
      title: joined.title,
      prompt: "",
      sourceCwd: consumer.sourceCwd,
      sourceRoots: consumer.sourceRoots,
      runInTarget: "localProject",
      operationId: joined.workspace.allocation_operation_id,
      reusePageWorkspace: { worktreeGitRoot, branchName: joined.workspace.branch_name },
    });
    return {
      ...shared,
      attach: (threadId: string) =>
        native.reconcile({ cwd: shared.location.cwd, threadId, sharedWorkspace: true }),
    };
  });
  /** Leases the checkout a chat joined, creating it first when the Page does not have one yet. */
  const checkout = Effect.fn("PageWorkspaceApplication.checkout")(function* (
    consumer: PageWorkspaceConsumer,
    joined: Joined,
  ) {
    const claimed = joined.workspace;
    if (claimed.lifecycle === "ready" && claimed.worktree_path)
      return yield* lease(consumer, joined, claimed.worktree_path);
    if (claimed.lifecycle !== "preparing" || !claimed.worktree_path)
      return yield* new PageWorkspaceError({ cause: new Error("Page Workspace is unavailable") });
    const created = yield* native
      .prepare({
        projectId: joined.projectId,
        targetId: consumer.sessionId,
        title: joined.title,
        prompt: "",
        sourceCwd: claimed.repository_root,
        sourceRoots: consumer.sourceRoots,
        runInTarget: "newWorktree",
        operationId: claimed.allocation_operation_id,
        pageWorkspace: {
          workspaceId: claimed.workspace_id,
          operationId: claimed.allocation_operation_id,
          branchName: claimed.branch_name,
          baseCommitOid: claimed.base_commit_oid,
          worktreePath: claimed.worktree_path,
        },
      })
      .pipe(
        Effect.tapError((cause) =>
          apply({
            kind: "record_page_workspace_failed",
            workspace_id: claimed.workspace_id,
            allocation_operation_id: claimed.allocation_operation_id,
            failure: readActionableErrorMessage(cause, {
              fallback: "Workspace preparation failed",
              maximumLength: 4096,
            }),
          }).pipe(Effect.ignore),
        ),
      );
    if (!created.branchName || !created.location.managedWorktreePath)
      return yield* new PageWorkspaceError({
        cause: new Error("Page Workspace branch is unavailable"),
      });
    yield* apply({
      kind: "record_page_workspace_ready",
      workspace_id: claimed.workspace_id,
      allocation_operation_id: claimed.allocation_operation_id,
      branch_name: created.branchName,
      worktree_path: created.location.managedWorktreePath,
    });
    const ready = (yield* readPage(claimed.page_id)).workspace;
    if (ready?.lifecycle !== "ready" || !ready.worktree_path)
      return yield* new PageWorkspaceError({
        cause: new Error("Page Workspace is awaiting cleanup"),
      });
    return yield* lease(consumer, { ...joined, workspace: ready }, ready.worktree_path);
  });
  const claim = Effect.fn("PageWorkspaceApplication.claim")(function* (
    input: PageWorkspaceConsumer & {
      readonly workPage: NonNullable<AgentRuntimeLaunch["workPage"]>;
      readonly launch: Pick<AgentRuntimeLaunch, "launchId" | "acceptedAt">;
    },
  ) {
    const joined = yield* join(input, input.workPage, input.launch);
    if (!joined) return null;
    const { workspace } = joined;
    return {
      workspace,
      lease:
        workspace.lifecycle === "ready" && workspace.worktree_path
          ? yield* lease(input, joined, workspace.worktree_path)
          : null,
    };
  });
  const prepare = Effect.fn("PageWorkspaceApplication.prepare")(function* (
    consumer: PageWorkspaceConsumer,
  ) {
    const read = yield* core.workspace.read(
      { kind: "session_workspace", session_id: consumer.sessionId },
      undefined,
      null,
    );
    const known = read.value.kind === "session_workspace" ? read.value.workspace : null;
    if (!known) return null;
    // The claim fixed the repository. A chat prepared again from another source root, as after
    // a restart, works at the top of the checkout.
    const root = yield* git.readPath(consumer.sourceCwd, ["rev-parse", "--show-toplevel"]);
    const source =
      root === known.repository_root ? consumer : { ...consumer, sourceCwd: known.repository_root };
    const joined = yield* join(source, { pageId: known.page_id });
    if (!joined)
      return yield* new PageWorkspaceError({ cause: new Error("Page Workspace is unavailable") });
    return yield* checkout(source, joined);
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
            if (!value.worktree_path)
              return yield* new PageWorkspaceError({
                cause: new Error("Page Workspace has no claimed checkout path"),
              });
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
              pageWorkspace: {
                workspaceId: value.workspace_id,
                operationId: value.allocation_operation_id,
                branchName: value.branch_name,
                baseCommitOid: value.base_commit_oid,
                worktreePath: value.worktree_path,
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
    /**
     * Launch admission: joins the chat to its work Page's Workspace without creating anything, so
     * it never waits on Git. Null when the chat gets no Workspace: its Project is not a
     * repository, or the Page has no Agent work and only that would open one. `lease` is the
     * checkout when the Page already has one; otherwise `prepare` creates it.
     */
    claim,
    /**
     * Leases the checkout of the Workspace a chat joined, creating it when it is missing; null
     * when the chat joined none. Repeatable: a failed or removed checkout is claimed again.
     */
    prepare: (consumer: PageWorkspaceConsumer) => lane.withPermits(1)(prepare(consumer)),
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
