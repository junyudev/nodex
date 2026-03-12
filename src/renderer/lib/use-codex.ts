import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { invoke, subscribeCodexEvents } from "./api";
import {
  readCodexThreadSettings,
  resolveCodexReasoningEffortOptions,
  resolveCodexThreadSettings,
  writeCodexThreadSettings,
} from "./codex-thread-settings";
import {
  codexStoreReducer,
  createInitialCodexStoreState,
} from "./codex-store";
import type {
  CodexAccountSnapshot,
  CodexApprovalDecision,
  CodexCollaborationModeKind,
  CodexCollaborationModePreset,
  CodexConnectionState,
  CodexItemView,
  CodexModelOption,
  CodexPermissionMode,
  CodexThreadSettings,
  CodexThreadStartForCardInput,
  CodexThreadDetail,
  CodexThreadSummary,
  CodexTurnStartOptions,
  CodexTurnSummary,
} from "./types";

const PERMISSION_MODE_STORAGE_KEY = "nodex-codex-permission-modes-v1";
const ACTIVE_THREAD_SYNC_INTERVAL_MS = 2_000;

function buildOptimisticThreadItemId(sequence: number): string {
  return `item-${Date.now()}${sequence}`;
}

function readPermissionModesFromStorage(): Record<string, CodexPermissionMode> {
  try {
    const raw = localStorage.getItem(PERMISSION_MODE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};

    return Object.entries(parsed).reduce<Record<string, CodexPermissionMode>>((acc, [projectId, mode]) => {
      if (mode !== "sandbox" && mode !== "full-access" && mode !== "custom") return acc;
      acc[projectId] = mode;
      return acc;
    }, {});
  } catch {
    return {};
  }
}

function writePermissionModesToStorage(value: Record<string, CodexPermissionMode>): void {
  try {
    localStorage.setItem(PERMISSION_MODE_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // ignore localStorage failures
  }
}

function resolveProjectPermissionMode(
  permissionModeByProject: Record<string, CodexPermissionMode>,
  projectId: string,
): CodexPermissionMode {
  return permissionModeByProject[projectId] ?? "custom";
}

export function useCodex(activeProjectId: string) {
  const [state, dispatch] = useReducer(codexStoreReducer, undefined, createInitialCodexStoreState);
  const [availableModels, setAvailableModels] = useState<CodexModelOption[]>([]);
  const [storedThreadSettings, setStoredThreadSettings] = useState<CodexThreadSettings>(() => readCodexThreadSettings() ?? {});
  const activeThreadSyncInFlight = useRef<Set<string>>(new Set());
  const optimisticThreadItemSequence = useRef(0);

  const loadConnectionAndAccount = useCallback(async () => {
    try {
      const connection = (await invoke("codex:connection:status")) as CodexConnectionState;
      dispatch({ type: "event", event: { type: "connection", connection } });
    } catch (error) {
      dispatch({
        type: "event",
        event: {
          type: "error",
          message: error instanceof Error ? error.message : "Could not read Codex connection status",
        },
      });
    }

    try {
      const account = (await invoke("codex:account:read")) as CodexAccountSnapshot;
      dispatch({ type: "event", event: { type: "account", account } });
    } catch (error) {
      dispatch({
        type: "event",
        event: {
          type: "error",
          message: error instanceof Error ? error.message : "Could not read Codex account",
        },
      });
    }
  }, []);

  const loadModels = useCallback(async () => {
    const models = (await invoke("codex:model:list")) as CodexModelOption[];
    setAvailableModels(models);
    return models;
  }, []);

  const listCollaborationModes = useCallback(async () => {
    return (await invoke("codex:collaboration-mode:list")) as CodexCollaborationModePreset[];
  }, []);

  const loadThreads = useCallback(
    async (projectId: string, opts?: { cardId?: string; includeArchived?: boolean }) => {
      const threads = (await invoke("codex:threads:list", projectId, opts)) as CodexThreadSummary[];
      dispatch({ type: "setThreads", projectId, threads });
      return threads;
    },
    [],
  );

  const readThread = useCallback(async (threadId: string, includeTurns = true) => {
    const detail = (await invoke("codex:thread:read", threadId, includeTurns)) as CodexThreadDetail | null;
    if (detail) {
      dispatch({ type: "setThreadDetail", detail });
    }
    return detail;
  }, []);

  const resumeThread = useCallback(async (threadId: string) => {
    const detail = (await invoke("codex:thread:resume", threadId)) as CodexThreadDetail | null;
    if (detail) {
      dispatch({ type: "setThreadDetail", detail });
    }
    return detail;
  }, []);

  const startThreadForCard = useCallback(
    async (input: CodexThreadStartForCardInput) => {
      const resolvedSettings = resolveCodexThreadSettings(storedThreadSettings, availableModels);
      const detail = (await invoke("codex:thread:start-for-card", {
        ...input,
        permissionMode: resolveProjectPermissionMode(state.permissionModeByProject, input.projectId),
        model: input.model ?? resolvedSettings.model,
        reasoningEffort: resolvedSettings.reasoningEffort,
      })) as CodexThreadDetail;
      dispatch({ type: "setThreadDetail", detail });
      await loadThreads(input.projectId);
      return detail;
    },
    [availableModels, loadThreads, state.permissionModeByProject, storedThreadSettings],
  );

  const setThreadName = useCallback(async (threadId: string, name: string, projectId: string) => {
    const result = (await invoke("codex:thread:name:set", threadId, name)) as boolean;
    if (result) {
      await loadThreads(projectId);
      await readThread(threadId, true);
    }
    return result;
  }, [loadThreads, readThread]);

  const archiveThread = useCallback(async (threadId: string, projectId: string) => {
    const result = (await invoke("codex:thread:archive", threadId)) as boolean;
    if (result) await loadThreads(projectId);
    return result;
  }, [loadThreads]);

  const unarchiveThread = useCallback(async (threadId: string, projectId: string) => {
    const result = (await invoke("codex:thread:unarchive", threadId)) as CodexThreadSummary | null;
    await loadThreads(projectId, { includeArchived: true });
    return result;
  }, [loadThreads]);

  const startTurn = useCallback(async (
    threadId: string,
    prompt: string,
    opts?: { projectId?: string; collaborationMode?: CodexCollaborationModeKind },
  ) => {
    dispatch({
      type: "event",
      event: {
        type: "threadStatus",
        threadId,
        statusType: "active",
        statusActiveFlags: [],
      },
    });

    try {
      const resolvedSettings = resolveCodexThreadSettings(storedThreadSettings, availableModels);
      const resolvedProjectId =
        opts?.projectId
        ?? state.threadDetailsById[threadId]?.projectId
        ?? activeProjectId;
      const turnOpts: CodexTurnStartOptions = {
        permissionMode: resolveProjectPermissionMode(state.permissionModeByProject, resolvedProjectId),
        model: resolvedSettings.model,
        reasoningEffort: resolvedSettings.reasoningEffort,
        collaborationMode: opts?.collaborationMode,
      };
      const turn = (await invoke("codex:turn:start", threadId, prompt, turnOpts)) as CodexTurnSummary | null;
      if (turn) {
        dispatch({ type: "event", event: { type: "turn", turn } });
      } else {
        await readThread(threadId, true);
      }
      return turn;
    } catch (error) {
      dispatch({
        type: "event",
        event: {
          type: "threadStatus",
          threadId,
          statusType: "idle",
          statusActiveFlags: [],
        },
      });
      await readThread(threadId, true).catch(() => {
        // Ignore refresh failures and surface the original mutation error.
      });
      throw error;
    }
  }, [activeProjectId, availableModels, readThread, state.permissionModeByProject, state.threadDetailsById, storedThreadSettings]);

  const steerTurn = useCallback(async (threadId: string, turnId: string, prompt: string) => {
    const promptText = prompt.trim();
    if (!promptText) {
      throw new Error("Turn steer requires a non-empty prompt");
    }

    const createdAt = Date.now();
    optimisticThreadItemSequence.current += 1;
    const optimisticItemId = buildOptimisticThreadItemId(optimisticThreadItemSequence.current);
    const optimisticItem: CodexItemView = {
      threadId,
      turnId,
      itemId: optimisticItemId,
      type: "userMessage",
      normalizedKind: "userMessage",
      status: "completed",
      role: "user",
      markdownText: promptText,
      createdAt,
      updatedAt: createdAt,
    };

    dispatch({ type: "optimisticItemUpsert", item: optimisticItem });

    try {
      const result = (await invoke(
        "codex:turn:steer",
        threadId,
        turnId,
        promptText,
        optimisticItemId,
      )) as { turnId: string } | null;
      if (result) return result;

      dispatch({ type: "removeThreadItem", threadId, turnId, itemId: optimisticItemId });
      await readThread(threadId, true).catch(() => {
        // Ignore refresh failures and preserve the null result.
      });
      return null;
    } catch (error) {
      dispatch({ type: "removeThreadItem", threadId, turnId, itemId: optimisticItemId });
      await readThread(threadId, true).catch(() => {
        // Ignore refresh failures and surface the original mutation error.
      });
      throw error;
    }
  }, [readThread]);

  const sendPromptToThread = useCallback(async (
    threadId: string,
    prompt: string,
    opts?: { projectId?: string; collaborationMode?: CodexCollaborationModeKind },
  ) => {
    const detail = state.threadDetailsById[threadId] ?? await readThread(threadId, true);
    const activeTurn = detail?.turns
      ?.filter((turn) => turn.status === "inProgress")
      .slice(-1)[0];

    if (activeTurn) {
      await steerTurn(threadId, activeTurn.turnId, prompt);
      return;
    }

    await startTurn(threadId, prompt, opts);
  }, [readThread, startTurn, state.threadDetailsById, steerTurn]);

  const interruptTurn = useCallback(async (threadId: string, turnId?: string) => {
    return (await invoke("codex:turn:interrupt", threadId, turnId)) as boolean;
  }, []);

  const respondApproval = useCallback(async (requestId: string, decision: CodexApprovalDecision) => {
    return (await invoke("codex:approval:respond", requestId, decision)) as boolean;
  }, []);

  const respondUserInput = useCallback(async (requestId: string, answers: Record<string, string[]>) => {
    return (await invoke("codex:user-input:respond", requestId, answers)) as boolean;
  }, []);

  const refreshAccount = useCallback(async () => {
    const account = (await invoke("codex:account:read")) as CodexAccountSnapshot;
    dispatch({ type: "event", event: { type: "account", account } });
    return account;
  }, []);

  const startChatGptLogin = useCallback(async () => {
    return (await invoke("codex:account:login:start", { type: "chatgpt" })) as
      | { type: "apiKey" }
      | { type: "chatgpt"; loginId: string; authUrl: string };
  }, []);

  const startApiKeyLogin = useCallback(async (apiKey: string) => {
    return (await invoke("codex:account:login:start", { type: "apiKey", apiKey })) as
      | { type: "apiKey" }
      | { type: "chatgpt"; loginId: string; authUrl: string };
  }, []);

  const cancelLogin = useCallback(async (loginId: string) => {
    return (await invoke("codex:account:login:cancel", loginId)) as { status: "canceled" | "notFound" };
  }, []);

  const logout = useCallback(async () => {
    return (await invoke("codex:account:logout")) as boolean;
  }, []);

  const resolvePlanImplementation = useCallback((threadId: string, turnId: string) => {
    dispatch({ type: "resolvePlanImplementation", threadId, turnId });
  }, []);

  const setPermissionMode = useCallback(async (projectId: string, mode: CodexPermissionMode) => {
    dispatch({ type: "setPermissionMode", projectId, mode });
    await invoke("codex:permission:mode:set", projectId, mode);
  }, []);

  const setThreadModel = useCallback((model: string) => {
    setStoredThreadSettings((current) => ({
      ...current,
      model,
    }));
  }, []);

  const setThreadReasoningEffort = useCallback(
    (reasoningEffort: CodexThreadSettings["reasoningEffort"]) => {
      if (!reasoningEffort) return;
      setStoredThreadSettings((current) => ({
        ...current,
        reasoningEffort,
      }));
    },
    [],
  );

  useEffect(() => {
    const stored = readPermissionModesFromStorage();
    Object.entries(stored).forEach(([projectId, mode]) => {
      dispatch({ type: "setPermissionMode", projectId, mode });
      void invoke("codex:permission:mode:set", projectId, mode).catch(() => {
        // ignore main-process availability errors on boot
      });
    });
  }, []);

  useEffect(() => {
    writePermissionModesToStorage(state.permissionModeByProject);
  }, [state.permissionModeByProject]);

  useEffect(() => {
    writeCodexThreadSettings(storedThreadSettings);
  }, [storedThreadSettings]);

  useEffect(() => {
    void loadConnectionAndAccount();
  }, [loadConnectionAndAccount]);

  useEffect(() => {
    void loadModels().catch(() => {
      setAvailableModels([]);
    });
  }, [loadModels]);

  useEffect(() => {
    if (!activeProjectId) return;
    void loadThreads(activeProjectId).catch((error) => {
      dispatch({
        type: "event",
        event: {
          type: "error",
          message: error instanceof Error ? error.message : "Could not load Codex threads",
        },
      });
    });
  }, [activeProjectId, loadThreads]);

  useEffect(() => {
    return subscribeCodexEvents((event) => {
      dispatch({ type: "event", event });
    });
  }, []);

  const activeThreadIds = useMemo(() => {
    const threadIds = new Set<string>();
    for (const threads of Object.values(state.threadsByProject)) {
      for (const thread of threads) {
        if (thread.statusType === "active") threadIds.add(thread.threadId);
      }
    }
    return Array.from(threadIds).sort();
  }, [state.threadsByProject]);
  const activeThreadIdsKey = useMemo(() => activeThreadIds.join("|"), [activeThreadIds]);

  useEffect(() => {
    if (activeThreadIdsKey.length === 0) return;
    const threadIds = activeThreadIdsKey.split("|").filter((threadId) => threadId.length > 0);
    if (threadIds.length === 0) return;

    let disposed = false;

    const syncActiveThreads = async () => {
      await Promise.all(
        threadIds.map(async (threadId) => {
          if (disposed) return;
          if (activeThreadSyncInFlight.current.has(threadId)) return;

          activeThreadSyncInFlight.current.add(threadId);
          try {
            await readThread(threadId, true);
          } catch {
            // Event stream remains the primary source of truth; polling is a safety net.
          } finally {
            activeThreadSyncInFlight.current.delete(threadId);
          }
        }),
      );
    };

    void syncActiveThreads();
    const intervalId = window.setInterval(() => {
      void syncActiveThreads();
    }, ACTIVE_THREAD_SYNC_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [activeThreadIdsKey, readThread]);

  const threads = useMemo(
    () => state.threadsByProject[activeProjectId] ?? [],
    [activeProjectId, state.threadsByProject],
  );
  const threadSettings = useMemo(
    () => resolveCodexThreadSettings(storedThreadSettings, availableModels),
    [availableModels, storedThreadSettings],
  );
  const reasoningEffortOptions = useMemo(
    () => resolveCodexReasoningEffortOptions(threadSettings.model, availableModels),
    [availableModels, threadSettings.model],
  );

  const permissionMode = state.permissionModeByProject[activeProjectId] ?? "custom";
  const approvalQueue = state.approvalQueue.filter(
    (request) => request.projectId === activeProjectId || request.projectId === null,
  );
  const userInputQueue = state.userInputQueue.filter(
    (request) => request.projectId === activeProjectId || request.projectId === null,
  );
  const planImplementationQueue = state.planImplementationQueue.filter(
    (request) => request.projectId === activeProjectId || request.projectId === null,
  );

  return {
    state,
    threads,
    availableModels,
    threadSettings,
    reasoningEffortOptions,
    permissionMode,
    approvalQueue,
    userInputQueue,
    planImplementationQueue,
    loadThreads,
    loadModels,
    listCollaborationModes,
    readThread,
    resumeThread,
    startThreadForCard,
    setThreadName,
    archiveThread,
    unarchiveThread,
    startTurn,
    sendPromptToThread,
    steerTurn,
    interruptTurn,
    respondApproval,
    respondUserInput,
    resolvePlanImplementation,
    refreshAccount,
    startChatGptLogin,
    startApiKeyLogin,
    cancelLogin,
    logout,
    setPermissionMode,
    setThreadModel,
    setThreadReasoningEffort,
  };
}
