import { useEffect, useEffectEvent, useLayoutEffect, useMemo, type RefObject } from "react";
import type { DatabaseViewRenderModel } from "@/lib/database-view-render-model";
import type { DatabaseViewMutationReceipt } from "@/lib/database-view-row-mutations";
import {
  createInteractionHistory,
  type InteractionHistory,
  type HistoryReplayHandle,
  type HistoryCommandResolution,
} from "@/lib/surface-history/owner";
import { acquireContentInteractionHistory } from "@/lib/content-interaction-history";
import { contentAccessContextKey } from "../../../shared/content-access-context";
import type {
  SurfaceHistoryDirection,
  SurfaceHistorySnapshot,
} from "../../../shared/surface-history";
import {
  databaseViewHistoryAdapter,
  type DatabaseViewBlockDropCommand,
  type DatabaseViewHistoryReceipt,
  type DatabaseViewOperationsCommand,
} from "./database-view-history-adapter";

export const databaseViewHistoryScopeKey = (
  model: Pick<
    DatabaseViewRenderModel,
    "libraryId" | "accessContext" | "storeEpoch" | "databaseViewId"
  >,
): string =>
  [
    model.libraryId,
    contentAccessContextKey(model.accessContext),
    model.storeEpoch,
    model.databaseViewId,
  ].join("\0");

export interface DatabaseViewHistoryTarget {
  readonly sequence: number;
}

export interface DatabaseViewMutationHistory {
  setScope(scopeKey: string): void;
  executeOperations(
    command: DatabaseViewOperationsCommand,
  ): Promise<DatabaseViewMutationReceipt | null>;
  executeBlockDrop(command: DatabaseViewBlockDropCommand): Promise<{
    readonly target: DatabaseViewHistoryTarget;
    readonly result: Extract<DatabaseViewHistoryReceipt, { readonly kind: "transfer" }>["result"];
  } | null>;
  request(
    direction: SurfaceHistoryDirection,
    target?: DatabaseViewHistoryTarget,
  ): HistoryReplayHandle;
  undoLast(): Promise<boolean>;
  undoTarget(target: DatabaseViewHistoryTarget): Promise<boolean>;
  snapshot(): SurfaceHistorySnapshot;
  subscribe(listener: () => void): () => void;
  recover(): HistoryReplayHandle;
  subscribeReplayCommitted(listener: () => void | Promise<void>): () => void;
  reset(): void;
  close(): void;
}

export class DatabaseViewHistoryCommandError extends Error {
  constructor(
    readonly status: "rejected" | "recovering" | "blocked",
    message: string,
  ) {
    super(message);
    this.name = "DatabaseViewHistoryCommandError";
  }
}

const receiptOf = (resolution: HistoryCommandResolution<DatabaseViewHistoryReceipt>) => {
  if (resolution.status === "committed") return resolution.receipt;
  if (resolution.status === "noop") return null;
  throw new DatabaseViewHistoryCommandError(resolution.status, resolution.reason);
};

/** The View submits semantic actions; it never receives a cancellable history slot. */
export const createDatabaseViewMutationHistory = (
  initialScopeKey: string,
  interactionHistory?: InteractionHistory,
): DatabaseViewMutationHistory => {
  let scopeKey = initialScopeKey;
  const realm = interactionHistory ?? createInteractionHistory({ scopeKey });
  const replayListeners = new Set<() => void | Promise<void>>();
  const owner = realm.bind({
    scopeKey,
    adapter: (intent: Parameters<typeof databaseViewHistoryAdapter>[0]) => {
      const adapter = databaseViewHistoryAdapter(intent);
      let replay = false;
      return {
        ...adapter,
        prepareInverse: (inverse: Parameters<typeof adapter.prepareInverse>[0]) => {
          replay = true;
          return adapter.prepareInverse(inverse);
        },
        onCommitted: async () => {
          if (!replay) return;
          await Promise.all([...replayListeners].map((listener) => listener()));
        },
      };
    },
  });
  const assertScope = (key: string) => {
    if (scopeKey !== key)
      throw new DatabaseViewHistoryCommandError(
        "rejected",
        "This Database View changed before the action started.",
      );
  };
  return {
    setScope: (key) => {
      scopeKey = key;
      owner.setScope(key);
    },
    executeOperations: async (command) => {
      assertScope(databaseViewHistoryScopeKey(command.model));
      if (command.operations.length === 0) return null;
      const receipt = receiptOf(await owner.execute({ kind: "data", command }).result);
      return receipt?.kind === "data" ? receipt.receipt : null;
    },
    executeBlockDrop: async (command) => {
      assertScope(command.historyScopeKey);
      const handle = owner.execute({ kind: "block_drop", command });
      const receipt = receiptOf(await handle.result);
      if (receipt?.kind !== "transfer" || handle.entryId === null) return null;
      return { result: receipt.result, target: { sequence: handle.entryId } };
    },
    request: (direction, target) => owner.request(direction, target?.sequence),
    undoLast: async () => (await owner.request("undo").result).status === "committed",
    undoTarget: async (target) =>
      (await owner.request("undo", target.sequence).result).status === "committed",
    snapshot: owner.snapshot,
    subscribe: owner.subscribe,
    recover: owner.recover,
    subscribeReplayCommitted: (listener) => {
      replayListeners.add(listener);
      return () => {
        replayListeners.delete(listener);
      };
    },
    reset: realm.reset,
    close: () => {
      owner.close();
      if (!interactionHistory) realm.close();
    },
  };
};

type ViewHistoryModel = Pick<
  DatabaseViewRenderModel,
  "libraryId" | "accessContext" | "storeEpoch" | "databaseViewId"
>;

/** Render creates only a facade; committed React lifetime owns realm admission. */
const createMountedViewHistory = (scopeKey: string) => {
  let owner: DatabaseViewMutationHistory | null = null;
  const listeners = new Set<() => void>();
  const replayListeners = new Set<() => void | Promise<void>>();
  const unavailable = () => {
    if (owner) return owner;
    throw new DatabaseViewHistoryCommandError("rejected", "This Database View is not attached.");
  };
  const empty: SurfaceHistorySnapshot = {
    ownerId: scopeKey,
    generation: 0,
    revision: 0,
    undo: { status: "empty", label: null, acceptsIntent: false, reason: null, recoveryActions: [] },
    redo: { status: "empty", label: null, acceptsIntent: false, reason: null, recoveryActions: [] },
  };
  const history: DatabaseViewMutationHistory = {
    setScope: (key) => unavailable().setScope(key),
    executeOperations: (command) => unavailable().executeOperations(command),
    executeBlockDrop: (command) => unavailable().executeBlockDrop(command),
    request: (direction, target) => unavailable().request(direction, target),
    undoLast: () => unavailable().undoLast(),
    undoTarget: (target) => unavailable().undoTarget(target),
    snapshot: () => owner?.snapshot() ?? empty,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeReplayCommitted: (listener) => {
      replayListeners.add(listener);
      return () => {
        replayListeners.delete(listener);
      };
    },
    recover: () => unavailable().recover(),
    reset: () => owner?.reset(),
    close: () => owner?.close(),
  };
  return {
    history,
    attach: (realm: InteractionHistory) => {
      const attached = createDatabaseViewMutationHistory(scopeKey, realm);
      owner = attached;
      const unsubscribe = attached.subscribe(() => {
        for (const listener of listeners) listener();
      });
      const unsubscribeReplay = attached.subscribeReplayCommitted(async () => {
        await Promise.all([...replayListeners].map((listener) => listener()));
      });
      for (const listener of listeners) listener();
      return () => {
        unsubscribe();
        unsubscribeReplay();
        attached.close();
        if (owner === attached) owner = null;
      };
    },
  };
};

export const useDatabaseViewMutationHistory = (
  model: ViewHistoryModel | null | undefined,
  provided?: DatabaseViewMutationHistory,
): DatabaseViewMutationHistory => {
  const scopeKey = model ? databaseViewHistoryScopeKey(model) : "pending";
  const mounted = useMemo(
    () => (provided ? null : createMountedViewHistory(scopeKey)),
    [provided, scopeKey],
  );
  const readModel = useEffectEvent(() => model);
  useLayoutEffect(() => {
    const model = readModel();
    if (!mounted || !model) return;
    const lease = acquireContentInteractionHistory(model);
    const detach = mounted.attach(lease.history);
    return () => {
      detach();
      lease.release();
    };
  }, [mounted, scopeKey]);
  return provided ?? mounted!.history;
};

interface UndoKeyboardEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey?: boolean;
  readonly isComposing?: boolean;
  readonly defaultPrevented?: boolean;
  readonly target: EventTarget | null;
  preventDefault(): void;
  stopPropagation(): void;
}

const ownsLocalUndo = (target: EventTarget | null): boolean => {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  const owner = target.closest(
    [
      "input",
      "textarea",
      "[contenteditable]",
      "[role=textbox]",
      "[role=combobox]",
      "[role=menu]",
    ].join(","),
  );
  return owner !== null && owner.getAttribute("contenteditable") !== "false";
};

interface ViewHistoryInput {
  readonly history: Pick<DatabaseViewMutationHistory, "request">;
  readonly onCommitted?: () => void | Promise<void>;
  readonly onBlocked?: (reason: string) => void;
}

const dispatchViewHistory = (input: ViewHistoryInput, direction: SurfaceHistoryDirection) => {
  void input.history
    .request(direction)
    .result.then((result) => {
      if (result.status !== "committed" && result.status !== "noop")
        input.onBlocked?.(result.reason);
    })
    .catch((error: unknown) =>
      input.onBlocked?.(
        error instanceof Error ? error.message : "This Database edit could not be reversed.",
      ),
    );
};

export const handleDatabaseViewMutationHistoryKeyDown = (
  input: ViewHistoryInput & { readonly event: UndoKeyboardEvent },
): boolean => {
  const { event } = input;
  if (
    !["z", "y"].includes(event.key.toLowerCase()) ||
    (!event.metaKey && !event.ctrlKey) ||
    event.altKey ||
    event.isComposing ||
    event.defaultPrevented ||
    ownsLocalUndo(event.target)
  )
    return false;
  event.preventDefault();
  event.stopPropagation();
  dispatchViewHistory(input, event.shiftKey || event.key.toLowerCase() === "y" ? "redo" : "undo");
  return true;
};

export const handleDatabaseViewHistoryBeforeInput = (
  input: ViewHistoryInput & { readonly event: InputEvent },
): boolean => {
  const { event } = input;
  if (event.defaultPrevented || event.isComposing || ownsLocalUndo(event.target)) return false;
  if (event.inputType !== "historyUndo" && event.inputType !== "historyRedo") return false;
  event.preventDefault();
  event.stopPropagation();
  dispatchViewHistory(input, event.inputType === "historyUndo" ? "undo" : "redo");
  return true;
};

export const useDatabaseViewHistoryInput = (
  elementRef: RefObject<HTMLElement | null>,
  input: ViewHistoryInput & { readonly history: DatabaseViewMutationHistory },
): void => {
  const onCommitted = useEffectEvent(() => input.onCommitted?.());
  useEffect(() => input.history.subscribeReplayCommitted(onCommitted), [input.history]);
  const dispatch = useEffectEvent((event: InputEvent) => {
    handleDatabaseViewHistoryBeforeInput({ ...input, event });
  });
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    element.addEventListener("beforeinput", dispatch);
    return () => element.removeEventListener("beforeinput", dispatch);
  }, [elementRef]);
};
