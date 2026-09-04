import { QueryClient, QueryClientProvider, type InfiniteData } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { LocalCommitApply } from "../../shared/local-commit-delivery";
import {
  DEFAULT_PROJECT_APPEARANCE,
  type ProjectAppearance,
} from "../../shared/project-appearance";
import { CoreApiError } from "./api";
import { projectCatalogStoreFor } from "./project-catalog";
import { queryKeys } from "./query-keys";
import type { Project, ProjectWindow } from "./types";
import { useProjectAppearanceMutation } from "./use-project-appearance-mutation";

const mocks = vi.hoisted(() => ({ invokeCommand: vi.fn(), toastDanger: vi.fn() }));

vi.mock("./renderer-command", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./renderer-command")>()),
  invokeLocalCommitCommand: mocks.invokeCommand,
}));

vi.mock("@/components/ui/toast", () => ({ toast: { danger: mocks.toastDanger } }));

const RED_FOLDER = {
  color: "red",
  marker: { kind: "icon", icon: "folder" },
} as const;
const RED_HEART = {
  color: "red",
  marker: { kind: "icon", icon: "heart" },
} as const;

function project(
  appearance: ProjectAppearance = DEFAULT_PROJECT_APPEARANCE,
  bindingRevision = 1,
): Project {
  return {
    id: "project-1",
    libraryId: "library-1",
    databaseId: "database-1",
    defaultDatabaseViewId: "view-1",
    lifecycle: "active",
    bindingRevision,
    name: "Nodex",
    description: "",
    appearance,
    sources: [],
    primaryWorkspaceRoot: null,
    pinned: false,
    pinnedOrder: null,
    created: new Date(0),
    updated: new Date(0),
  };
}

function projectWindow(): InfiniteData<ProjectWindow, string | null> {
  return {
    pageParams: [null],
    pages: [
      {
        items: [project()],
        nextCursor: null,
        hasMore: false,
        storeEpoch: "epoch-1",
        projectionRevision: 1,
      },
    ],
  };
}

function committed(commitSeq: number): LocalCommitApply {
  return {
    status: "committed",
    commit: {
      store_epoch: "epoch-1",
      commit_seq: commitSeq,
      manifest_hash: "f".repeat(64),
    },
    delivery: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function setupHook() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const initialProject = project();
  client.setQueryData(queryKeys.projects.list(false), projectWindow());
  const catalog = projectCatalogStoreFor(client);
  catalog.publishCanonical({
    storeEpoch: "epoch-1",
    projectionRevision: 1,
    projects: [initialProject],
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const hook = renderHook(
    ({ currentProject }: { currentProject: Project }) =>
      useProjectAppearanceMutation(currentProject),
    { initialProps: { currentProject: initialProject }, wrapper },
  );
  const presentedAppearance = () => catalog.project(initialProject)?.appearance;
  const cachedAppearance = () =>
    client.getQueryData<InfiniteData<ProjectWindow, string | null>>(queryKeys.projects.list(false))
      ?.pages[0]?.items[0]?.appearance;
  return { catalog, hook, initialProject, presentedAppearance, cachedAppearance };
}

describe("useProjectAppearanceMutation", () => {
  beforeEach(() => {
    mocks.invokeCommand.mockReset();
    mocks.toastDanger.mockReset();
  });

  it("presents through the catalog owner without rewriting canonical query data", async () => {
    const request = deferred<{ value: Project; acknowledgement: LocalCommitApply }>();
    mocks.invokeCommand.mockReturnValue(request.promise);
    const { hook, initialProject, presentedAppearance, cachedAppearance } = setupHook();

    act(() => hook.result.current.changeAppearance(RED_HEART));

    expect(presentedAppearance()).toEqual(RED_HEART);
    expect(cachedAppearance()).toEqual(DEFAULT_PROJECT_APPEARANCE);
    await waitFor(() => expect(mocks.invokeCommand).toHaveBeenCalledTimes(1));
    request.resolve({ value: project(RED_HEART, 2), acknowledgement: committed(2) });
    await act(async () => await request.promise);
    expect(mocks.invokeCommand.mock.calls[0]?.[1]).toMatchObject({
      projectId: initialProject.id,
      updates: { appearance: RED_HEART },
    });
    expect(presentedAppearance()).toEqual(RED_HEART);
  });

  it("serializes rapid changes and preserves the latest presentation", async () => {
    const first = deferred<{ value: Project; acknowledgement: LocalCommitApply }>();
    const second = deferred<{ value: Project; acknowledgement: LocalCommitApply }>();
    mocks.invokeCommand.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { hook, presentedAppearance } = setupHook();

    act(() => {
      hook.result.current.changeAppearance(RED_FOLDER);
      hook.result.current.changeAppearance(RED_HEART);
    });
    expect(presentedAppearance()).toEqual(RED_HEART);
    await waitFor(() => expect(mocks.invokeCommand).toHaveBeenCalledTimes(1));

    await act(async () => {
      first.resolve({ value: project(RED_FOLDER, 2), acknowledgement: committed(2) });
      await first.promise;
    });
    await waitFor(() => expect(mocks.invokeCommand).toHaveBeenCalledTimes(2));
    expect(presentedAppearance()).toEqual(RED_HEART);

    await act(async () => {
      second.resolve({ value: project(RED_HEART, 3), acknowledgement: committed(3) });
      await second.promise;
    });
    expect(presentedAppearance()).toEqual(RED_HEART);
  });

  it("rolls back only a definitive latest failure", async () => {
    mocks.invokeCommand.mockResolvedValueOnce({
      value: project(RED_FOLDER, 2),
      acknowledgement: committed(2),
    });
    mocks.invokeCommand.mockRejectedValueOnce(
      new CoreApiError({
        code: "revision_conflict",
        message: "The Project changed",
        retryable: false,
        recovery: { kind: "none" },
      }),
    );
    const { hook, presentedAppearance } = setupHook();

    await act(async () => await hook.result.current.changeAppearanceAsync(RED_FOLDER));
    await expect(
      act(async () => await hook.result.current.changeAppearanceAsync(RED_HEART)),
    ).rejects.toThrow("The Project changed");

    expect(presentedAppearance()).toEqual(RED_FOLDER);
    expect(mocks.toastDanger).toHaveBeenCalledTimes(1);
  });

  it("retains an unknown outcome and retries the exact operation identity", async () => {
    mocks.invokeCommand.mockRejectedValueOnce(new Error("response lost"));
    mocks.invokeCommand.mockResolvedValueOnce({
      value: project(RED_HEART, 2),
      acknowledgement: committed(2),
    });
    const { catalog, hook, initialProject, presentedAppearance } = setupHook();

    await expect(
      act(async () => await hook.result.current.changeAppearanceAsync(RED_HEART)),
    ).rejects.toThrow("response lost");
    const firstCommand = mocks.invokeCommand.mock.calls[0]?.[1];
    expect(presentedAppearance()).toEqual(RED_HEART);
    expect(catalog.getSnapshot().unknownOutcomeCount).toBe(1);

    await act(async () => {
      await catalog.retryProjectUpdate(initialProject.id);
    });
    expect(mocks.invokeCommand.mock.calls[1]?.[1].operationId).toBe(firstCommand.operationId);
    expect(presentedAppearance()).toEqual(RED_HEART);
  });

  it("waits for the whole rapid queue and returns the newest confirmed revision", async () => {
    const first = deferred<{ value: Project; acknowledgement: LocalCommitApply }>();
    const second = deferred<{ value: Project; acknowledgement: LocalCommitApply }>();
    mocks.invokeCommand.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { hook } = setupHook();

    act(() => {
      hook.result.current.changeAppearance(RED_FOLDER);
      hook.result.current.changeAppearance(RED_HEART);
    });
    const waiting = hook.result.current.waitForSettledProject();
    await act(async () => {
      first.resolve({ value: project(RED_FOLDER, 2), acknowledgement: committed(2) });
      await first.promise;
    });
    await waitFor(() => expect(mocks.invokeCommand).toHaveBeenCalledTimes(2));
    await act(async () => {
      second.resolve({ value: project(RED_HEART, 3), acknowledgement: committed(3) });
      await waiting;
    });

    await expect(waiting).resolves.toMatchObject({
      bindingRevision: 3,
      appearance: RED_HEART,
    });
  });

  it("returns the latest refreshed Project when no write is pending", async () => {
    const { hook, initialProject } = setupHook();
    const refreshed = { ...initialProject, name: "Nodex refreshed", bindingRevision: 7 };

    await act(async () => {
      hook.rerender({ currentProject: refreshed });
      await Promise.resolve();
    });

    await expect(hook.result.current.waitForSettledProject()).resolves.toMatchObject({
      name: "Nodex refreshed",
      bindingRevision: 7,
    });
  });
});
