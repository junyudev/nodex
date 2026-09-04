import { useEffect, useEffectEvent, useRef, type RefObject } from "react";
import type { DatabaseViewRenderModel } from "@/lib/database-view-render-model";
import type { DatabaseViewMutationReceipt } from "@/lib/database-view-row-mutations";
import {
  createSurfaceHistory,
  type HistoryCommandHandle,
  type HistoryCommandResolution,
} from "@/lib/surface-history/owner";
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
  ): HistoryCommandHandle<DatabaseViewHistoryReceipt>;
  undoLast(): Promise<boolean>;
  undoTarget(target: DatabaseViewHistoryTarget): Promise<boolean>;
  snapshot(): SurfaceHistorySnapshot;
  subscribe(listener: () => void): () => void;
  recover(): HistoryCommandHandle<DatabaseViewHistoryReceipt>;
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
): DatabaseViewMutationHistory => {
  let scopeKey = initialScopeKey;
  const owner = createSurfaceHistory({ scopeKey, adapter: databaseViewHistoryAdapter });
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
    reset: owner.reset,
    close: owner.close,
  };
};

export const useDatabaseViewMutationHistory = (scopeKey: string): DatabaseViewMutationHistory => {
  const historyRef = useRef<DatabaseViewMutationHistory | null>(null);
  historyRef.current ??= createDatabaseViewMutationHistory(scopeKey);
  historyRef.current.setScope(scopeKey);
  return historyRef.current;
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
    .result.then(async (result) => {
      if (result.status === "committed") await input.onCommitted?.();
      else if (result.status !== "noop") input.onBlocked?.(result.reason);
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
  input: ViewHistoryInput,
): void => {
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
