import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { DatabaseChangeEvent } from "../../shared/database-events";
import { parseDatabaseViewId } from "../../shared/database-identities";

const testState = vi.hoisted(() => ({
  readDatabaseModule: vi.fn(),
  applyDatabaseModule: vi.fn(),
  changeListener: null as ((event: DatabaseChangeEvent) => void) | null,
}));

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  readDatabaseModule: testState.readDatabaseModule,
  applyDatabaseModule: testState.applyDatabaseModule,
  subscribeDatabaseChanges: vi.fn((_: string, listener: (event: DatabaseChangeEvent) => void) => {
    testState.changeListener = listener;
    return () => {
      if (testState.changeListener === listener) testState.changeListener = null;
    };
  }),
}));

import {
  resetDatabaseViewPersonalPreferencesForTests,
  useDatabaseViewPersonalPreference,
} from "./database-view-personal-preferences";

const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

const viewId = parseDatabaseViewId("0198a4f1-b850-7000-8000-000000000001");

const presentationResult = (
  presentationOverride: Readonly<Record<string, unknown>> = {},
  revision = 4,
  storeEpoch = "epoch-loaded",
  commitSeq = 10,
) => ({
  ok: true as const,
  value: {
    storeEpoch,
    commitSeq,
    value: {
      kind: "view_personal_preferences" as const,
      value: { rulesOverride: {}, presentationOverride, revision },
    },
  },
});

const disclosureResult = (
  targets: readonly { readonly kind: "group" | "page"; readonly occurrenceKey: string }[] = [],
  storeEpoch = "epoch-loaded",
  commitSeq = 10,
) => ({
  ok: true as const,
  value: {
    storeEpoch,
    commitSeq,
    value: {
      kind: "view_collapsed_occurrences" as const,
      value: { targets },
    },
  },
});

const disclosureWriteResult = (commitSeq: number) => ({
  ok: true as const,
  value: {
    committedRevisions: {},
    commitSeq,
  },
  localCommit: { status: "applied" as const },
});

describe("useDatabaseViewPersonalPreference", () => {
  beforeEach(() => {
    resetDatabaseViewPersonalPreferencesForTests();
    window.localStorage.clear();
    testState.changeListener = null;
    testState.readDatabaseModule.mockReset();
    testState.applyDatabaseModule.mockReset().mockResolvedValue({
      ok: true,
      value: {
        committedRevisions: {
          [`view_presentation:profile:${viewId}`]: 5,
        },
        commitSeq: 12,
      },
      localCommit: { status: "applied" },
    });
  });

  test("serializes an optimistic occurrence disclosure behind both authority reads", async () => {
    const presentation = deferred<ReturnType<typeof presentationResult>>();
    const disclosure = deferred<ReturnType<typeof disclosureResult>>();
    testState.readDatabaseModule.mockImplementation(
      (
        _: string,
        request: {
          readonly read: { readonly mode: string };
        },
      ) =>
        request.read.mode === "view_personal_preferences"
          ? presentation.promise
          : disclosure.promise,
    );

    const { result } = renderHook(() => useDatabaseViewPersonalPreference("project-test", viewId));
    await waitFor(() => expect(testState.readDatabaseModule).toHaveBeenCalledTimes(2));

    let collapseResult: Promise<boolean> | undefined;
    act(() => {
      collapseResult = result.current.setOccurrenceDisclosure(
        { kind: "group", occurrenceKey: 'GROUP_"local"' },
        true,
      );
    });
    expect(result.current.collapsedOccurrenceKeys).toEqual(['GROUP_"local"']);
    expect(testState.applyDatabaseModule).not.toHaveBeenCalled();

    await act(async () => {
      presentation.resolve(presentationResult());
      disclosure.resolve(disclosureResult([{ kind: "group", occurrenceKey: 'GROUP_"server"' }]));
      await collapseResult;
    });

    expect(await collapseResult).toBe(true);
    expect(testState.applyDatabaseModule).toHaveBeenCalledWith(
      "project-test",
      expect.objectContaining({
        storeEpoch: "epoch-loaded",
        operations: [
          {
            kind: "set_view_occurrence_disclosure",
            viewId,
            target: { kind: "group", occurrenceKey: 'GROUP_"local"' },
            collapsed: true,
          },
        ],
      }),
    );
    expect(result.current.collapsedOccurrenceKeys).toEqual(['GROUP_"local"', 'GROUP_"server"']);
  });

  test("retains one hydrated personal state store across surface remounts", async () => {
    testState.readDatabaseModule.mockImplementation(
      (
        _: string,
        request: {
          readonly read: { readonly mode: string };
        },
      ) =>
        Promise.resolve(
          request.read.mode === "view_personal_preferences"
            ? presentationResult()
            : disclosureResult([{ kind: "page", occurrenceKey: "ITEM_build/page" }]),
        ),
    );

    const first = renderHook(() => useDatabaseViewPersonalPreference("project-test", viewId));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    first.unmount();
    const second = renderHook(() => useDatabaseViewPersonalPreference("project-test", viewId));

    expect(second.result.current).toMatchObject({
      presentationOverride: {},
      collapsedOccurrenceKeys: ["ITEM_build/page"],
      preferencesRevision: 4,
      loading: false,
      error: null,
    });
    expect(testState.readDatabaseModule).toHaveBeenCalledTimes(2);
  });

  test("applies cross-window personal deltas without re-reading shared View data", async () => {
    testState.readDatabaseModule.mockImplementation(
      (
        _: string,
        request: {
          readonly read: { readonly mode: string };
        },
      ) =>
        Promise.resolve(
          request.read.mode === "view_personal_preferences"
            ? presentationResult()
            : disclosureResult(),
        ),
    );
    const { result } = renderHook(() => useDatabaseViewPersonalPreference("project-test", viewId));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() =>
      testState.changeListener?.({
        version: 3,
        projectId: "project-test",
        storeEpoch: "epoch-loaded",
        operationId: "remote-operation",
        sourceKind: "database_module",
        affectedDatabaseIds: [],
        affectedDataSourceIds: [],
        affectedPageIds: [],
        affectedViewIds: [],
        commitSeq: 11,
        personalViewChanges: [
          {
            kind: "preferences",
            viewId,
            rulesOverride: {},
            presentationOverride: {},
            revision: 5,
          },
          {
            kind: "occurrence_disclosure",
            viewId,
            target: { kind: "page", occurrenceKey: "ITEM_build/page" },
            collapsed: true,
          },
        ],
      }),
    );

    expect(result.current).toMatchObject({
      presentationOverride: {},
      collapsedOccurrenceKeys: ["ITEM_build/page"],
      preferencesRevision: 5,
    });
    expect(testState.readDatabaseModule).toHaveBeenCalledTimes(2);
  });

  test("keeps the latest optimistic disclosure visible while older writes settle", async () => {
    testState.readDatabaseModule.mockImplementation(
      (
        _: string,
        request: {
          readonly read: { readonly mode: string };
        },
      ) =>
        Promise.resolve(
          request.read.mode === "view_personal_preferences"
            ? presentationResult()
            : disclosureResult(),
        ),
    );
    const firstWrite = deferred<ReturnType<typeof disclosureWriteResult>>();
    const secondWrite = deferred<ReturnType<typeof disclosureWriteResult>>();
    testState.applyDatabaseModule
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);
    const { result } = renderHook(() => useDatabaseViewPersonalPreference("project-test", viewId));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const target = { kind: "page" as const, occurrenceKey: "ITEM_build/page" };

    let collapse: Promise<boolean> | undefined;
    let expand: Promise<boolean> | undefined;
    act(() => {
      collapse = result.current.setOccurrenceDisclosure(target, true);
      expand = result.current.setOccurrenceDisclosure(target, false);
    });
    expect(result.current.collapsedOccurrenceKeys).toEqual([]);
    await waitFor(() => expect(testState.applyDatabaseModule).toHaveBeenCalledTimes(1));

    await act(async () => {
      firstWrite.resolve(disclosureWriteResult(11));
      await collapse;
    });
    expect(result.current.collapsedOccurrenceKeys).toEqual([]);
    await waitFor(() => expect(testState.applyDatabaseModule).toHaveBeenCalledTimes(2));

    await act(async () => {
      secondWrite.resolve(disclosureWriteResult(12));
      await expand;
    });
    expect(await collapse).toBe(true);
    expect(await expand).toBe(true);
    expect(result.current.collapsedOccurrenceKeys).toEqual([]);
  });

  test("retains the last presentation while an independent Store epoch hydrates", async () => {
    const epochTwoPresentation = deferred<ReturnType<typeof presentationResult>>();
    const epochTwoDisclosure = deferred<ReturnType<typeof disclosureResult>>();
    let reads = 0;
    testState.readDatabaseModule.mockImplementation(
      (
        _: string,
        request: {
          readonly read: { readonly mode: string };
        },
      ) => {
        reads += 1;
        if (reads <= 2) {
          return Promise.resolve(
            request.read.mode === "view_personal_preferences"
              ? presentationResult({}, 4, "epoch-one")
              : disclosureResult([], "epoch-one"),
          );
        }
        return request.read.mode === "view_personal_preferences"
          ? epochTwoPresentation.promise
          : epochTwoDisclosure.promise;
      },
    );
    const { result } = renderHook(() => useDatabaseViewPersonalPreference("project-test", viewId));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.synchronizeStoreEpoch("epoch-two"));
    expect(result.current).toMatchObject({
      presentationOverride: {},
      loading: true,
    });

    await act(async () => {
      epochTwoPresentation.resolve(presentationResult({}, 1, "epoch-two", 1));
      epochTwoDisclosure.resolve(disclosureResult([], "epoch-two", 1));
      await Promise.all([epochTwoPresentation.promise, epochTwoDisclosure.promise]);
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({
      presentationOverride: {},
      preferencesRevision: 1,
      loading: false,
    });
  });
});
