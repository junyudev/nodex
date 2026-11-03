import { useCallback, useLayoutEffect, useRef, type UIEventHandler } from "react";

const MAX_RETAINED_SCROLL_ENTRIES = 200;

export interface RetainedScrollSnapshot {
  top: number;
  left: number;
  updatedAtMs: number;
}

type RetainedScrollAxis = "vertical" | "horizontal" | "both";

interface RestoreRetainedScrollPositionOptions {
  axis?: RetainedScrollAxis;
  retryFrames?: 0 | 1 | 2;
}

type UseRetainedScrollPositionOptions = RestoreRetainedScrollPositionOptions;

interface UseRetainedScrollPositionResult<T extends HTMLElement> {
  ref: (node: T | null) => void;
  onScroll: UIEventHandler<T>;
  saveNow: () => void;
}

const retainedScrollSnapshots = new Map<string, RetainedScrollSnapshot>();

function normalizeScrollValue(value: number): number {
  if (Number.isFinite(value)) return value;
  return 0;
}

function touchRetainedScrollKey(key: string, snapshot: RetainedScrollSnapshot): void {
  retainedScrollSnapshots.delete(key);
  retainedScrollSnapshots.set(key, snapshot);
}

function makeScrollSnapshot(element: HTMLElement): RetainedScrollSnapshot {
  return {
    top: normalizeScrollValue(element.scrollTop),
    left: normalizeScrollValue(element.scrollLeft),
    updatedAtMs: Date.now(),
  };
}

function rememberRetainedScrollSnapshot(key: string, snapshot: RetainedScrollSnapshot): void {
  touchRetainedScrollKey(key, snapshot);
  pruneRetainedScrollSnapshots();
}

function elementHasLayoutBox(element: HTMLElement): boolean {
  return element.isConnected && element.getClientRects().length > 0;
}

function applyScrollSnapshot(
  element: HTMLElement,
  snapshot: RetainedScrollSnapshot,
  axis: RetainedScrollAxis,
): void {
  if (axis === "vertical" || axis === "both") {
    element.scrollTop = snapshot.top;
  }
  if (axis === "horizontal" || axis === "both") {
    element.scrollLeft = snapshot.left;
  }
}

function pruneRetainedScrollSnapshots(): void {
  while (retainedScrollSnapshots.size > MAX_RETAINED_SCROLL_ENTRIES) {
    const oldestKey = retainedScrollSnapshots.keys().next().value;
    if (typeof oldestKey !== "string") return;
    retainedScrollSnapshots.delete(oldestKey);
  }
}

export function rememberRetainedScrollPosition(key: string, element: HTMLElement): void {
  rememberRetainedScrollSnapshot(key, makeScrollSnapshot(element));
}

export function readRetainedScrollPosition(key: string): RetainedScrollSnapshot | null {
  const snapshot = retainedScrollSnapshots.get(key);
  if (!snapshot) return null;

  touchRetainedScrollKey(key, snapshot);
  return { ...snapshot };
}

export function restoreRetainedScrollPosition(
  key: string,
  element: HTMLElement,
  options: RestoreRetainedScrollPositionOptions = {},
): boolean {
  const snapshot = readRetainedScrollPosition(key);
  if (!snapshot) return false;

  const axis = options.axis ?? "both";
  applyScrollSnapshot(element, snapshot, axis);

  const retryFrames = options.retryFrames ?? 0;
  if (retryFrames <= 0 || typeof requestAnimationFrame !== "function") {
    return true;
  }

  let remainingFrames = retryFrames;
  const runAfterFrame = () => {
    applyScrollSnapshot(element, snapshot, axis);
    remainingFrames -= 1;
    if (remainingFrames > 0) {
      requestAnimationFrame(runAfterFrame);
    }
  };
  requestAnimationFrame(runAfterFrame);
  return true;
}

export function forgetRetainedScrollPosition(key: string): void {
  retainedScrollSnapshots.delete(key);
}

export function useRetainedScrollPosition<T extends HTMLElement>(
  key: string | null,
  options: UseRetainedScrollPositionOptions = {},
): UseRetainedScrollPositionResult<T> {
  const nodeRef = useRef<T | null>(null);
  const nodeKeyRef = useRef<string | null>(null);
  const lastKnownSnapshotRef = useRef<{
    key: string;
    snapshot: RetainedScrollSnapshot;
  } | null>(null);
  const restoreVersionRef = useRef(0);

  const axis = options.axis ?? "both";
  const retryFrames = options.retryFrames ?? 0;

  const rememberNodePosition = useCallback((snapshotKey: string, node: T) => {
    if (elementHasLayoutBox(node)) {
      const snapshot = makeScrollSnapshot(node);
      lastKnownSnapshotRef.current = { key: snapshotKey, snapshot };
      rememberRetainedScrollSnapshot(snapshotKey, snapshot);
      return;
    }

    const lastKnown = lastKnownSnapshotRef.current;
    if (lastKnown?.key === snapshotKey) {
      rememberRetainedScrollSnapshot(snapshotKey, lastKnown.snapshot);
      return;
    }

    const existing = readRetainedScrollPosition(snapshotKey);
    if (existing) {
      lastKnownSnapshotRef.current = { key: snapshotKey, snapshot: existing };
    }
  }, []);

  const restoreNodePosition = useCallback(
    (snapshotKey: string, node: T) => {
      restoreVersionRef.current += 1;
      const restoreVersion = restoreVersionRef.current;
      const snapshot = readRetainedScrollPosition(snapshotKey);
      if (!snapshot) return;
      applyScrollSnapshot(node, snapshot, axis);
      lastKnownSnapshotRef.current = { key: snapshotKey, snapshot };

      if (retryFrames <= 0 || typeof requestAnimationFrame !== "function") return;
      let remainingFrames = retryFrames;
      const retryRestore = () => {
        if (restoreVersionRef.current !== restoreVersion) return;
        if (nodeRef.current !== node) return;
        if (nodeKeyRef.current !== snapshotKey) return;
        applyScrollSnapshot(node, snapshot, axis);
        remainingFrames -= 1;
        if (remainingFrames > 0) requestAnimationFrame(retryRestore);
      };
      requestAnimationFrame(retryRestore);
    },
    [axis, retryFrames],
  );

  const saveNow = useCallback(() => {
    const node = nodeRef.current;
    const currentKey = nodeKeyRef.current ?? key;
    if (!node || !currentKey) return;
    rememberNodePosition(currentKey, node);
  }, [key, rememberNodePosition]);

  const ref = useCallback(
    (node: T | null) => {
      const previousNode = nodeRef.current;
      const previousKey = nodeKeyRef.current;
      if (previousNode && previousKey) {
        rememberNodePosition(previousKey, previousNode);
      }

      nodeRef.current = node;
      nodeKeyRef.current = key;
      if (!node || !key) return;
      restoreNodePosition(key, node);
    },
    [key, rememberNodePosition, restoreNodePosition],
  );

  const onScroll = useCallback<UIEventHandler<T>>(
    (event) => {
      const currentKey = nodeKeyRef.current ?? key;
      if (!currentKey) return;
      const snapshot = makeScrollSnapshot(event.currentTarget);
      lastKnownSnapshotRef.current = { key: currentKey, snapshot };
      rememberRetainedScrollSnapshot(currentKey, snapshot);
    },
    [key],
  );

  useLayoutEffect(() => {
    const node = nodeRef.current;
    const previousKey = nodeKeyRef.current;
    if (node && previousKey && previousKey !== key) {
      rememberNodePosition(previousKey, node);
    }

    nodeKeyRef.current = key;
    if (!node || !key) return;

    restoreNodePosition(key, node);
    return () => {
      rememberNodePosition(key, node);
    };
  }, [key, rememberNodePosition, restoreNodePosition]);

  return { ref, onScroll, saveNow };
}
