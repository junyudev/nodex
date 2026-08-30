import { describe, expect, it } from "vite-plus/test";

import type { LocalCommitApply } from "../../shared/local-commit-delivery";
import type { Project } from "./types";
import {
  createProjectCatalogStore,
  type ProjectCatalogStore,
  type ProjectCatalogUpdateCommand,
  type ProjectCatalogUpdateTransportResult,
} from "./project-catalog-store";
import {
  createRendererCausalTrace,
  createRendererCausalTraceContext,
} from "./renderer-causal-trace";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function project(name: string, bindingRevision = 1): Project {
  return {
    id: "project-1",
    libraryId: "library-1",
    databaseId: "database-1",
    defaultDatabaseViewId: "view-1",
    lifecycle: "active",
    bindingRevision,
    name,
    description: "",
    appearance: { color: "black", marker: { kind: "icon", icon: "folder" } },
    sources: [],
    primaryWorkspaceRoot: null,
    pinned: false,
    pinnedOrder: null,
    created: new Date("2026-08-31T00:00:00.000Z"),
    updated: new Date("2026-08-31T00:00:00.000Z"),
  };
}

function committed(storeEpoch: string, commitSeq: number): LocalCommitApply {
  return {
    status: "committed",
    commit: {
      store_epoch: storeEpoch,
      commit_seq: commitSeq,
      manifest_hash: "f".repeat(64),
    },
    delivery: null,
  };
}

function noOp(storeEpoch: string, commitHead: number): LocalCommitApply {
  return {
    status: "no_op",
    observed: {
      store_epoch: storeEpoch,
      commit_head: commitHead,
    },
  };
}

function acknowledged(
  name: string,
  acknowledgement: LocalCommitApply,
): ProjectCatalogUpdateTransportResult {
  return {
    kind: "acknowledged",
    project: project(name, 2),
    acknowledgement,
  };
}

function canonical(
  store: ProjectCatalogStore,
  name: string,
  projectionRevision: number,
  storeEpoch = "epoch-1",
): void {
  store.publishCanonical({
    storeEpoch,
    projectionRevision,
    projects: [project(name, projectionRevision)],
  });
}

function operationIds() {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `operation-${sequence}`;
  };
}

describe("ProjectCatalogStore", () => {
  it("presents a rename over list and detail values before entering transport", async () => {
    const request = deferred<ProjectCatalogUpdateTransportResult>();
    const commands: ProjectCatalogUpdateCommand[] = [];
    let presentedAtSend = "";
    let store!: ProjectCatalogStore;
    store = createProjectCatalogStore({
      operationId: operationIds(),
      port: {
        send: async (command) => {
          commands.push(command);
          presentedAtSend = store.project(project("Old name"))?.name ?? "";
          return await request.promise;
        },
      },
    });
    canonical(store, "Old name", 1);
    const canonicalList = [project("Old name")];
    const mutation = store.renameProject("project-1", "New name");

    expect(store.project(project("Old name"))?.name).toBe("New name");
    expect(store.projects(canonicalList)[0]?.name).toBe("New name");
    expect(store.projects(canonicalList)).not.toBe(canonicalList);
    expect(store.getSnapshot().pendingCount).toBe(1);

    await flushMicrotasks();
    expect(presentedAtSend).toBe("New name");
    expect(commands).toEqual([
      {
        operationId: "operation-1",
        projectId: "project-1",
        updates: { name: "New name", expectedBindingRevision: 1 },
      },
    ]);

    request.resolve(acknowledged("New name", committed("epoch-1", 2)));
    await expect(mutation).resolves.toMatchObject({ kind: "acknowledged" });
  });

  it("keeps an acknowledged overlay through stale reads and requires its exact render token", async () => {
    const trace = createRendererCausalTrace({ enabled: true, capacity: 16, now: () => 1 });
    const store = createProjectCatalogStore({
      operationId: operationIds(),
      trace,
      port: {
        send: async (command) => {
          trace.record(
            createRendererCausalTraceContext({
              semanticKey: "workspace.project.update",
              operationIdentity: command.operationId,
              owner: "project-catalog",
              protocol: "receipt_fenced_projection",
              scopeKind: "project",
            }),
            { kind: "submitted", reason: "transport_submit" },
          );
          return acknowledged("New name", committed("epoch-1", 4));
        },
      },
    });
    canonical(store, "Old name", 3);

    await expect(store.renameProject("project-1", "New name")).resolves.toMatchObject({
      kind: "acknowledged",
    });
    expect(store.getSnapshot().renderToken).toBeNull();
    expect(store.project(project("Old name"))?.name).toBe("New name");

    canonical(store, "Old name", 3);
    expect(store.getSnapshot().renderToken).toBeNull();
    canonical(store, "New name", 4);
    const token = store.getSnapshot().renderToken;
    expect(token).not.toBeNull();

    canonical(store, "New name", 4);
    expect(store.getSnapshot().renderToken).toBe(token);
    store.markRendered((token ?? 0) + 1);
    expect(store.getSnapshot().pendingCount).toBe(1);
    store.markRendered(token ?? 0);

    expect(store.getSnapshot()).toMatchObject({ pendingCount: 0, renderToken: null });
    expect(store.project(project("New name"))?.name).toBe("New name");
    expect(store.projects([project("New name")])).toEqual([project("New name")]);
    expect(trace.snapshot().events.map(({ kind }) => kind)).toEqual([
      "local_intent",
      "submitted",
      "acknowledged",
      "materialized",
      "rendered",
      "settled",
    ]);
    expect(trace.reduce()).toMatchObject({ legal: true });
  });

  it("accepts canonical materialization before a committed acknowledgement", async () => {
    const request = deferred<ProjectCatalogUpdateTransportResult>();
    const store = createProjectCatalogStore({
      operationId: operationIds(),
      port: { send: async () => await request.promise },
    });
    store.publishCanonical({
      storeEpoch: "epoch-1",
      projectionRevision: 1,
      projects: [project("Old name", 5)],
    });
    const mutation = store.renameProject("project-1", "New name");
    await flushMicrotasks();

    canonical(store, "New name", 6);
    expect(store.getSnapshot().renderToken).toBeNull();
    request.resolve(acknowledged("New name", committed("epoch-1", 6)));
    await mutation;

    const token = store.getSnapshot().renderToken;
    expect(token).not.toBeNull();
    store.markRendered(token ?? 0);
    expect(store.getSnapshot().pendingCount).toBe(0);
  });

  it("settles a no-op only after the observed canonical value renders", async () => {
    const request = deferred<ProjectCatalogUpdateTransportResult>();
    const store = createProjectCatalogStore({
      operationId: operationIds(),
      port: { send: async () => await request.promise },
    });
    canonical(store, "Canonical", 8);
    const mutation = store.renameProject("project-1", "Canonical");
    await flushMicrotasks();

    request.resolve(acknowledged("Canonical", noOp("epoch-1", 8)));
    await mutation;
    const token = store.getSnapshot().renderToken;
    expect(token).not.toBeNull();
    store.markRendered(token ?? 0);
    expect(store.getSnapshot().pendingCount).toBe(0);
  });

  it("retains an unknown outcome and retries with the exact operation identity", async () => {
    const commands: ProjectCatalogUpdateCommand[] = [];
    let attempt = 0;
    let durableEffects = 0;
    const durableOperationIds = new Set<string>();
    const store = createProjectCatalogStore({
      operationId: operationIds(),
      port: {
        send: async (command) => {
          commands.push(command);
          if (!durableOperationIds.has(command.operationId)) {
            durableOperationIds.add(command.operationId);
            durableEffects += 1;
          }
          attempt += 1;
          if (attempt === 1) throw new Error("response lost");
          return acknowledged("Retried", committed("epoch-1", 2));
        },
      },
    });
    canonical(store, "Old name", 1);

    await expect(store.renameProject("project-1", "Retried")).resolves.toMatchObject({
      kind: "unknown_outcome",
      failure: { code: "transport_unknown_outcome" },
    });
    expect(store.getSnapshot()).toMatchObject({ pendingCount: 1, unknownOutcomeCount: 1 });
    expect(store.project(project("Old name"))?.name).toBe("Retried");

    store.publishCanonical({
      storeEpoch: "epoch-1",
      projectionRevision: 1,
      projects: [project("Old name", 5)],
    });
    await expect(store.retryProjectUpdate("project-1")).resolves.toMatchObject({
      kind: "acknowledged",
    });
    expect(commands.map((command) => command.operationId)).toEqual(["operation-1", "operation-1"]);
    expect(commands[1]).toEqual(commands[0]);
    expect(durableEffects).toBe(1);
    canonical(store, "Retried", 2);
    const token = store.getSnapshot().renderToken;
    store.markRendered(token ?? 0);
    expect(store.getSnapshot().pendingCount).toBe(0);
  });

  it("serializes sends while a later intent presents immediately and survives the older result", async () => {
    const first = deferred<ProjectCatalogUpdateTransportResult>();
    const second = deferred<ProjectCatalogUpdateTransportResult>();
    const commands: ProjectCatalogUpdateCommand[] = [];
    const store = createProjectCatalogStore({
      operationId: operationIds(),
      port: {
        send: async (command) => {
          commands.push(command);
          return await (commands.length === 1 ? first.promise : second.promise);
        },
      },
    });
    canonical(store, "Original", 1);
    const firstMutation = store.renameProject("project-1", "First");
    const secondMutation = store.renameProject("project-1", "Second");

    expect(store.project(project("Original"))?.name).toBe("Second");
    await flushMicrotasks();
    expect(commands).toHaveLength(1);

    first.resolve({
      kind: "definitive_failure",
      failure: { code: "revision_conflict", message: "First failed" },
    });
    await expect(firstMutation).resolves.toMatchObject({ kind: "definitive_failure" });
    expect(store.project(project("Original"))?.name).toBe("Second");
    await flushMicrotasks();
    expect(commands.map((command) => command.operationId)).toEqual(["operation-1", "operation-2"]);

    second.resolve(acknowledged("Second", committed("epoch-1", 2)));
    await expect(secondMutation).resolves.toMatchObject({ kind: "acknowledged" });
    canonical(store, "Second", 2);
    const token = store.getSnapshot().renderToken;
    store.markRendered(token ?? 0);
    expect(store.getSnapshot().pendingCount).toBe(0);
  });

  it("retires an older unknown intent only when a newer materialization has rendered", async () => {
    let attempt = 0;
    const store = createProjectCatalogStore({
      operationId: operationIds(),
      port: {
        send: async () => {
          attempt += 1;
          if (attempt === 1) {
            return {
              kind: "unknown_outcome",
              failure: { code: "unknown", message: "No response" },
            };
          }
          return acknowledged("Second", committed("epoch-1", 3));
        },
      },
    });
    canonical(store, "Original", 1);
    await store.renameProject("project-1", "First");
    await store.renameProject("project-1", "Second");
    expect(store.getSnapshot().pendingCount).toBe(2);

    canonical(store, "Second", 3);
    const token = store.getSnapshot().renderToken;
    expect(token).not.toBeNull();
    expect(store.project(project("Second", 3))?.name).toBe("Second");
    store.markRendered(token ?? 0);
    expect(store.getSnapshot()).toMatchObject({ pendingCount: 0, unknownOutcomeCount: 0 });
  });

  it("does not retire an unrelated unknown field when a later field materializes", async () => {
    const red = {
      color: "red",
      marker: { kind: "icon", icon: "heart" },
    } as const;
    let attempt = 0;
    const store = createProjectCatalogStore({
      operationId: operationIds(),
      port: {
        send: async () => {
          attempt += 1;
          if (attempt === 1) {
            return {
              kind: "unknown_outcome",
              failure: { code: "unknown", message: "No response" },
            };
          }
          return acknowledged("Original", committed("epoch-1", 3));
        },
      },
    });
    canonical(store, "Original", 1);
    await store.renameProject("project-1", "Uncertain name");
    await store.updateProject("project-1", { appearance: red, sources: ["/tmp/nodex"] });

    const canonicalProject = {
      ...project("Original", 3),
      appearance: red,
      sources: [{ root: "/tmp/nodex", order: 0 }],
    };
    store.publishCanonical({
      storeEpoch: "epoch-1",
      projectionRevision: 3,
      projects: [canonicalProject],
    });
    const token = store.getSnapshot().renderToken;
    expect(token).not.toBeNull();
    store.markRendered(token ?? 0);

    expect(store.getSnapshot()).toMatchObject({ pendingCount: 1, unknownOutcomeCount: 1 });
    expect(store.project(canonicalProject)).toMatchObject({
      name: "Uncertain name",
      appearance: red,
      sources: [{ root: "/tmp/nodex", order: 0 }],
    });
  });

  it("clears retained presentation on Store replacement and ignores late old-Store evidence", async () => {
    const request = deferred<ProjectCatalogUpdateTransportResult>();
    const store = createProjectCatalogStore({
      operationId: operationIds(),
      port: { send: async () => await request.promise },
    });
    canonical(store, "Old authority", 7, "epoch-old");
    const mutation = store.renameProject("project-1", "Pending old edit");
    await flushMicrotasks();
    expect(store.project(project("Old authority"))?.name).toBe("Pending old edit");

    canonical(store, "Replacement authority", 0, "epoch-new");
    expect(store.getSnapshot().pendingCount).toBe(0);
    expect(store.project(project("Replacement authority"))?.name).toBe("Replacement authority");

    request.resolve(acknowledged("Pending old edit", committed("epoch-old", 8)));
    await expect(mutation).resolves.toEqual({ kind: "superseded" });
    canonical(store, "Late old authority", 8, "epoch-old");
    expect(store.project(project("Replacement authority"))?.name).toBe("Replacement authority");
  });

  it("starts a fresh transport lane when Store authority is replaced", async () => {
    const oldRequest = deferred<ProjectCatalogUpdateTransportResult>();
    const newRequest = deferred<ProjectCatalogUpdateTransportResult>();
    const sentNames: string[] = [];
    const store = createProjectCatalogStore({
      operationId: operationIds(),
      port: {
        send: async (command) => {
          const name = command.updates.name ?? "";
          sentNames.push(name);
          return await (name === "Old pending edit" ? oldRequest.promise : newRequest.promise);
        },
      },
    });
    canonical(store, "Old authority", 7, "epoch-old");
    const oldMutation = store.renameProject("project-1", "Old pending edit");
    await flushMicrotasks();
    expect(sentNames).toEqual(["Old pending edit"]);

    canonical(store, "Replacement authority", 1, "epoch-new");
    const newMutation = store.renameProject("project-1", "New authority edit");
    const waiting = store.waitForProjectUpdates(project("Replacement authority", 1));
    let waitingCompleted = false;
    void waiting.then(() => {
      waitingCompleted = true;
    });
    await flushMicrotasks();
    expect(sentNames).toEqual(["Old pending edit", "New authority edit"]);

    oldRequest.resolve(acknowledged("Old pending edit", committed("epoch-old", 8)));
    await expect(oldMutation).resolves.toEqual({ kind: "superseded" });
    await flushMicrotasks();
    expect(waitingCompleted).toBe(false);

    newRequest.resolve(acknowledged("New authority edit", committed("epoch-new", 2)));
    await expect(newMutation).resolves.toMatchObject({
      kind: "acknowledged",
      project: { name: "New authority edit" },
    });
    await expect(waiting).resolves.toMatchObject({ name: "New authority edit" });
    expect(store.project(project("Replacement authority", 1))?.name).toBe("New authority edit");
  });

  it("bounds retained unknown outcomes without evicting an unresolved intent", async () => {
    const store = createProjectCatalogStore({
      operationId: operationIds(),
      maxRetainedUpdates: 1,
      port: {
        send: async () => ({
          kind: "unknown_outcome",
          failure: { code: "unknown", message: "No response" },
        }),
      },
    });
    canonical(store, "Original", 1);
    await store.renameProject("project-1", "Retained");

    await expect(store.renameProject("project-1", "Rejected")).resolves.toEqual({
      kind: "definitive_failure",
      failure: {
        code: "renderer_catalog_capacity",
        message: "Too many Project updates are awaiting settlement",
      },
    });
    expect(store.getSnapshot()).toMatchObject({ pendingCount: 1, unknownOutcomeCount: 1 });
    expect(store.project(project("Original"))?.name).toBe("Retained");
  });

  it("waits for the active Project lane before opening an editor snapshot", async () => {
    const request = deferred<ProjectCatalogUpdateTransportResult>();
    const store = createProjectCatalogStore({
      operationId: operationIds(),
      port: { send: async () => await request.promise },
    });
    const fallback = project("Original", 1);
    canonical(store, "Original", 1);
    const update = store.renameProject("project-1", "Renamed");
    const waiting = store.waitForProjectUpdates(fallback);
    let completed = false;
    void waiting.then(() => {
      completed = true;
    });
    await flushMicrotasks();
    expect(completed).toBe(false);

    request.resolve(acknowledged("Renamed", committed("epoch-1", 2)));
    await update;
    await expect(waiting).resolves.toMatchObject({
      name: "Renamed",
      bindingRevision: 2,
    });
  });
});
