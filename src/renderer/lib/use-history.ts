import { useCallback, useEffect, useRef, useState } from "react";
import type { UndoRedoResult, UndoRedoState } from "../../shared/ipc-api";
import { invoke } from "./api";
import { TOAST_CLEANUP_MS } from "./timing";

export type { UndoRedoState };

export function useHistory(projectId: string) {
  // Generate a unique session ID for this browser session
  const [sessionId] = useState(() => {
    const stored = sessionStorage.getItem("kanban-session-id");
    if (stored) return stored;
    const newId = crypto.randomUUID();
    sessionStorage.setItem("kanban-session-id", newId);
    return newId;
  });

  const [state, setState] = useState<UndoRedoState>({
    canUndo: false,
    canRedo: false,
    undoDescription: null,
    redoDescription: null,
  });

  const [lastAction, setLastAction] = useState<{
    type: "undo" | "redo";
    description: string;
  } | null>(null);

  // Track if we're currently performing an undo/redo to prevent double actions
  const isActingRef = useRef(false);

  const refreshState = useCallback(async () => {
    try {
      const data = (await invoke(
        "history:recent",
        projectId,
        sessionId
      )) as UndoRedoState;
      setState({
        canUndo: data.canUndo,
        canRedo: data.canRedo,
        undoDescription: data.undoDescription,
        redoDescription: data.redoDescription,
      });
    } catch (err) {
      console.error("Failed to refresh history state:", err);
    }
  }, [projectId, sessionId]);

  const undo = useCallback(async (): Promise<boolean> => {
    if (isActingRef.current || !state.canUndo) return false;

    isActingRef.current = true;
    try {
      const data = (await invoke(
        "history:undo",
        projectId,
        sessionId
      )) as UndoRedoResult;

      setState({
        canUndo: data.canUndo,
        canRedo: data.canRedo,
        undoDescription: data.undoDescription,
        redoDescription: data.redoDescription,
      });

      if (data.success && data.entry) {
        setLastAction({
          type: "undo",
          description: getActionDescription("undo", data.entry.operation),
        });
      }

      return data.success;
    } catch (err) {
      console.error("Failed to undo:", err);
      return false;
    } finally {
      isActingRef.current = false;
    }
  }, [projectId, sessionId, state.canUndo]);

  const redo = useCallback(async (): Promise<boolean> => {
    if (isActingRef.current || !state.canRedo) return false;

    isActingRef.current = true;
    try {
      const data = (await invoke(
        "history:redo",
        projectId,
        sessionId
      )) as UndoRedoResult;

      setState({
        canUndo: data.canUndo,
        canRedo: data.canRedo,
        undoDescription: data.undoDescription,
        redoDescription: data.redoDescription,
      });

      if (data.success && data.entry) {
        setLastAction({
          type: "redo",
          description: getActionDescription("redo", data.entry.operation),
        });
      }

      return data.success;
    } catch (err) {
      console.error("Failed to redo:", err);
      return false;
    } finally {
      isActingRef.current = false;
    }
  }, [projectId, sessionId, state.canRedo]);

  // Clear last action after a timeout (for toast dismissal)
  useEffect(() => {
    if (lastAction) {
      const timer = setTimeout(() => setLastAction(null), TOAST_CLEANUP_MS);
      return () => clearTimeout(timer);
    }
  }, [lastAction]);

  // Refresh state on mount
  useEffect(() => {
    refreshState();
  }, [refreshState]);

  return {
    sessionId,
    canUndo: state.canUndo,
    canRedo: state.canRedo,
    undoDescription: state.undoDescription,
    redoDescription: state.redoDescription,
    lastAction,
    undo,
    redo,
    refreshState,
    clearLastAction: () => setLastAction(null),
  };
}

function getActionDescription(
  action: "undo" | "redo",
  operation: string
): string {
  const verb = action === "undo" ? "Undid" : "Redid";
  switch (operation) {
    case "create":
      return `${verb} card creation`;
    case "delete":
      return `${verb} card deletion`;
    case "move":
      return `${verb} card move`;
    case "update":
      return `${verb} card update`;
    default:
      return `${verb} action`;
  }
}
