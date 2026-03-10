import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasData } from "./types";
import { invoke } from "./api";
import { registerAppCloseFlushHandler } from "./app-close-flush";

interface UseCanvasStateOptions {
  projectId: string;
}

interface CanvasInitialData {
  elements: unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

function stripVolatileKeys(appState: Record<string, unknown>): Record<string, unknown> {
  const { collaborators: _c, selectedElementIds: _sel, ...persistState } = appState;
  void _c; void _sel;
  return persistState;
}

export function collectReferencedFileIds(elements: readonly unknown[]): Set<string> {
  const fileIds = new Set<string>();

  for (const element of elements) {
    if (!element || typeof element !== "object") continue;

    const maybeElement = element as { fileId?: unknown; type?: unknown; isDeleted?: unknown };
    if (maybeElement.type !== "image") continue;
    if (maybeElement.isDeleted === true) continue;
    if (typeof maybeElement.fileId !== "string") continue;

    fileIds.add(maybeElement.fileId);
  }

  return fileIds;
}

export function pickReferencedFiles(
  elements: readonly unknown[],
  files: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!files) return {};
  const ids = collectReferencedFileIds(elements);
  if (ids.size === 0) return {};

  const result: Record<string, unknown> = {};
  for (const id of ids) {
    const file = files[id];
    if (file !== undefined) result[id] = file;
  }
  return result;
}

export function useCanvasState({ projectId }: UseCanvasStateOptions) {
  const [initialData, setInitialData] = useState<CanvasInitialData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<{ projectId: string; elements: string; appState: string; files: string } | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  const enqueueSave = useCallback((pending: { projectId: string; elements: string; appState: string; files: string }) => {
    saveQueueRef.current = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        await invoke("canvas:save", pending.projectId, {
          elements: pending.elements,
          appState: pending.appState,
          files: pending.files,
          updated: new Date().toISOString(),
        });
      });
    return saveQueueRef.current;
  }, []);

  // Flush pending save immediately (for unmount / project switch)
  const flushSave = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pending = pendingSaveRef.current;
    if (pending) {
      pendingSaveRef.current = null;
      await enqueueSave(pending);
      return;
    }
    await saveQueueRef.current.catch(() => undefined);
  }, [enqueueSave]);

  // Load canvas on mount / project change — flush previous project first
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    void (async () => {
      await flushSave();
      if (cancelled) return;
      try {
        const data = (await invoke("canvas:get", projectId)) as CanvasData | null;
        if (cancelled) return;

        if (data) {
          setInitialData({
            elements: JSON.parse(data.elements) as unknown[],
            appState: JSON.parse(data.appState) as Record<string, unknown>,
            files: JSON.parse(typeof data.files === "string" ? data.files : "{}") as Record<string, unknown>,
          });
        } else {
          setInitialData({ elements: [], appState: {}, files: {} });
        }
      } catch {
        if (!cancelled) {
          setInitialData({ elements: [], appState: {}, files: {} });
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Debounced save (1s)
  const saveCanvas = useCallback(
    (
      elements: readonly unknown[],
      appState: Record<string, unknown>,
      files: Record<string, unknown> | undefined,
    ) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

      const persistState = stripVolatileKeys(appState);
      const persistFiles = pickReferencedFiles(elements, files);
      pendingSaveRef.current = {
        projectId,
        elements: JSON.stringify(elements),
        appState: JSON.stringify(persistState),
        files: JSON.stringify(persistFiles),
      };

      saveTimerRef.current = setTimeout(() => {
        const pending = pendingSaveRef.current;
        if (!pending) return;
        pendingSaveRef.current = null;
        saveTimerRef.current = null;
        void enqueueSave(pending);
      }, 1000);
    },
    [enqueueSave, projectId],
  );

  // Flush pending save during page lifecycle transitions
  useEffect(() => {
    const onPageHide = () => {
      void flushSave();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") return;
      void flushSave();
    };

    window.addEventListener("beforeunload", onPageHide);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("beforeunload", onPageHide);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [flushSave]);

  useEffect(() => {
    return registerAppCloseFlushHandler(flushSave);
  }, [flushSave]);

  // Flush pending save on unmount
  useEffect(() => {
    return () => {
      void flushSave();
    };
  }, [flushSave]);

  return { initialData, isLoading, saveCanvas };
}
