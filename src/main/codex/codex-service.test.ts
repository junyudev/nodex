import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CodexEvent,
  CodexItemView,
  CodexCollaborationModePreset,
  CodexPermissionMode,
  CodexThreadDetail,
  CodexTurnSummary,
  ManagedWorktreeRecord,
} from "../../shared/types";
import {
  closeDatabase,
  createCard,
  createProject,
  deleteCard,
  getCard,
  initializeDatabase,
} from "../kanban/db-service";
import { CodexRpcError } from "./codex-app-server-client";
import { getCodexCardThreadLink, upsertCodexCardThreadLink, upsertCodexThreadSnapshot } from "./codex-link-repository";
import { CodexService } from "./codex-service";

interface TestableCodexService {
  shutdown: () => Promise<void>;
  readThreadAfterStart: (threadId: string) => Promise<CodexThreadDetail | null>;
  readThread: (threadId: string, includeTurns?: boolean) => Promise<CodexThreadDetail | null>;
  serializeThreadDetail: (threadId: string) => CodexThreadDetail | null;
  startTurn: (
    threadId: string,
    prompt: string,
    opts?: {
      model?: string;
      reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
      permissionMode?: CodexPermissionMode;
      collaborationMode?: "default" | "plan";
    },
  ) => Promise<CodexTurnSummary | null>;
  steerTurn: (
    threadId: string,
    expectedTurnId: string,
    prompt: string,
    optimisticItemId?: string,
  ) => Promise<{ turnId: string } | null>;
  startThreadForCard: (input: {
    projectId: string;
    cardId: string;
    prompt: string;
    threadName?: string;
    model?: string;
    permissionMode?: CodexPermissionMode;
    reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    collaborationMode?: "default" | "plan";
    worktreeStartMode?: "autoBranch" | "detachedHead";
    worktreeBranchPrefix?: string;
  }) => Promise<CodexThreadDetail>;
  listCollaborationModes: () => Promise<CodexCollaborationModePreset[]>;
  interruptTurn: (threadId: string, turnId?: string) => Promise<boolean>;
  respondToUserInput: (requestId: string, answers: Record<string, string[]>) => Promise<boolean>;
  setProjectPermissionMode: (projectId: string, mode: CodexPermissionMode) => void;
  getCustomPermissionModeDescription: (projectId: string) => string;
  listManagedWorktrees: () => Promise<ManagedWorktreeRecord[]>;
  deleteManagedWorktree: (threadId: string) => Promise<boolean>;
}

function makeThreadDetail(threadId: string): CodexThreadDetail {
  return {
    threadId,
    projectId: "project-1",
    cardId: "card-1",
    threadName: "Thread",
    threadPreview: "",
    modelProvider: "openai",
    cwd: "/tmp",
    statusType: "active",
    statusActiveFlags: [],
    archived: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    linkedAt: new Date().toISOString(),
    turns: [],
    items: [],
  };
}

function createService(): TestableCodexService {
  return new CodexService() as unknown as TestableCodexService;
}

function isUnsupportedSqliteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("better-sqlite3") && message.includes("not yet supported");
}

async function withTempDatabase(run: () => Promise<void>): Promise<boolean> {
  closeDatabase();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-codex-service-"));
  process.env.KANBAN_DIR = tempDir;

  try {
    await initializeDatabase();
  } catch (error) {
    if (isUnsupportedSqliteError(error)) {
      closeDatabase();
      fs.rmSync(tempDir, { recursive: true, force: true });
      delete process.env.KANBAN_DIR;
      return false;
    }
    throw error;
  }

  createProject({ id: "codex", name: "Codex", workspacePath: "/tmp/codex" });

  try {
    await run();
    return true;
  } finally {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.KANBAN_DIR;
  }
}

function initializeGitRepository(repoPath: string): void {
  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoPath });
  execFileSync("git", ["config", "user.name", "Nodex Test"], { cwd: repoPath });
  execFileSync("git", ["config", "user.email", "nodex@example.com"], { cwd: repoPath });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# test\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoPath });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoPath });
}

describe("codex-service thread start fallback", () => {
  test("falls back to includeTurns=false when rollout is not materialized", async () => {
    const service = createService();
    const fallbackDetail = makeThreadDetail("thr-fallback");

    try {
      service.readThread = async (_threadId: string, includeTurns = true) => {
        if (includeTurns) {
          throw new CodexRpcError(
            "failed to load rollout `/tmp/session.jsonl` for thread thr-fallback: empty session file",
            -32603,
          );
        }
        return fallbackDetail;
      };

      service.serializeThreadDetail = () => null;

      const detail = await service.readThreadAfterStart("thr-fallback");
      expect(detail).toBe(fallbackDetail);
    } finally {
      await service.shutdown();
    }
  });

  test("falls back to serialized thread detail when both reads are unavailable", async () => {
    const service = createService();
    const serializedDetail = makeThreadDetail("thr-serialized");

    try {
      service.readThread = async () => {
        throw new CodexRpcError(
          "failed to load rollout `/tmp/session.jsonl` for thread thr-serialized: empty session file",
          -32603,
        );
      };

      service.serializeThreadDetail = () => serializedDetail;

      const detail = await service.readThreadAfterStart("thr-serialized");
      expect(detail).toBe(serializedDetail);
    } finally {
      await service.shutdown();
    }
  });

  test("falls back for includeTurns pre-materialization error wording", async () => {
    const service = createService();
    const fallbackDetail = makeThreadDetail("thr-not-materialized");

    try {
      service.readThread = async (_threadId: string, includeTurns = true) => {
        if (includeTurns) {
          throw new CodexRpcError(
            "thread 019c86c9-78f8-7c22-bbb8-ece0f52f8794 is not materialized yet; includeTurns is unavailable before first user message",
            -32600,
          );
        }
        return fallbackDetail;
      };

      service.serializeThreadDetail = () => null;

      const detail = await service.readThreadAfterStart("thr-not-materialized");
      expect(detail).toBe(fallbackDetail);
    } finally {
      await service.shutdown();
    }
  });

  test("falls back for rollout-is-empty wording", async () => {
    const service = createService();
    const fallbackDetail = makeThreadDetail("thr-rollout-empty");

    try {
      service.readThread = async (_threadId: string, includeTurns = true) => {
        if (includeTurns) {
          throw new CodexRpcError(
            "failed to load rollout `/tmp/session.jsonl` for thread thr-rollout-empty: rollout at /tmp/session.jsonl is empty",
            -32603,
          );
        }
        return fallbackDetail;
      };

      service.serializeThreadDetail = () => null;

      const detail = await service.readThreadAfterStart("thr-rollout-empty");
      expect(detail).toBe(fallbackDetail);
    } finally {
      await service.shutdown();
    }
  });

  test("does not swallow non-rollout errors", async () => {
    const service = createService();
    let fallbackReadUsed = false;

    try {
      service.readThread = async (_threadId: string, includeTurns = true) => {
        if (!includeTurns) {
          fallbackReadUsed = true;
        }
        throw new CodexRpcError("permission denied", -32603);
      };

      service.serializeThreadDetail = () => null;

      let failed = false;
      let message = "";
      try {
        await service.readThreadAfterStart("thr-error");
      } catch (error) {
        failed = true;
        message = error instanceof Error ? error.message : String(error);
      }

      expect(failed).toBeTrue();
      expect(message.includes("permission denied")).toBeTrue();
      expect(fallbackReadUsed).toBeFalse();
    } finally {
      await service.shutdown();
    }
  });
});

describe("codex-service readThread fallback", () => {
  test("retries with includeTurns=false for pre-materialization errors", async () => {
    const ran = await withTempDatabase(async () => {
      const card = await createCard("codex", "in_progress", { title: "Read thread fallback" });
      upsertCodexCardThreadLink({
        projectId: "codex",
        cardId: card.id,
        threadId: "thr_read_fallback",
      });

      const service = createService();
      const client = Reflect.get(service as object, "client") as {
        start: () => Promise<void>;
        request: (method: string, params: unknown) => Promise<{ thread?: unknown }>;
      };
      const includeTurnsCalls: boolean[] = [];

      client.start = async () => undefined;
      client.request = async (method: string, params: unknown) => {
        if (method !== "thread/read") return {};

        const request = params as { includeTurns?: boolean };
        const includeTurns = request.includeTurns === true;
        includeTurnsCalls.push(includeTurns);
        if (includeTurns) {
          throw new CodexRpcError(
            "thread 019cb472-b24b-79b2-bdac-aa9dbc4eb28f is not materialized yet; includeTurns is unavailable before first user message",
            -32600,
          );
        }

        return {
          thread: {
            id: "thr_read_fallback",
            turns: [],
          },
        };
      };

      try {
        const detail = await service.readThread("thr_read_fallback", true);
        expect(detail).not.toBeNull();
        expect(detail?.threadId).toBe("thr_read_fallback");
        expect(includeTurnsCalls.length).toBe(2);
        expect(includeTurnsCalls[0]).toBeTrue();
        expect(includeTurnsCalls[1]).toBeFalse();
      } finally {
        await service.shutdown();
      }
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("does not retry includeTurns=false for non-rollout errors", async () => {
    const ran = await withTempDatabase(async () => {
      const card = await createCard("codex", "in_progress", { title: "Read thread non-rollout error" });
      upsertCodexCardThreadLink({
        projectId: "codex",
        cardId: card.id,
        threadId: "thr_read_error",
      });

      const service = createService();
      const client = Reflect.get(service as object, "client") as {
        start: () => Promise<void>;
        request: (method: string, params: unknown) => Promise<{ thread?: unknown }>;
      };
      const includeTurnsCalls: boolean[] = [];

      client.start = async () => undefined;
      client.request = async (method: string, params: unknown) => {
        if (method !== "thread/read") return {};
        const request = params as { includeTurns?: boolean };
        includeTurnsCalls.push(request.includeTurns === true);
        throw new CodexRpcError("permission denied", -32603);
      };

      try {
        let failed = false;
        let message = "";
        try {
          await service.readThread("thr_read_error", true);
        } catch (error) {
          failed = true;
          message = error instanceof Error ? error.message : String(error);
        }

        expect(failed).toBeTrue();
        expect(message.includes("permission denied")).toBeTrue();
        expect(includeTurnsCalls.length).toBe(1);
        expect(includeTurnsCalls[0]).toBeTrue();
      } finally {
        await service.shutdown();
      }
    });

    if (!ran) expect(true).toBeTrue();
  });
});

describe("codex-service thread snapshot cache", () => {
  test("serializeThreadDetail rehydrates from persisted snapshot when in-memory cache is empty", async () => {
    const ran = await withTempDatabase(async () => {
      const card = await createCard("codex", "in_progress", { title: "Thread snapshot fallback" });
      upsertCodexCardThreadLink({
        projectId: "codex",
        cardId: card.id,
        threadId: "thr_cached",
      });

      upsertCodexThreadSnapshot({
        threadId: "thr_cached",
        turns: [
          {
            threadId: "thr_cached",
            turnId: "turn_cached",
            status: "completed",
            itemIds: ["item_cached"],
          },
        ],
        items: [
          {
            threadId: "thr_cached",
            turnId: "turn_cached",
            itemId: "item_cached",
            type: "mcpToolCall",
            normalizedKind: "toolCall",
            toolCall: {
              subtype: "mcp",
              toolName: "search",
              server: "docs",
            },
            createdAt: 10,
            updatedAt: 11,
          },
        ],
      });

      const service = createService();
      try {
        const detail = service.serializeThreadDetail("thr_cached");
        expect(detail).not.toBeNull();
        expect(detail?.turns.length).toBe(1);
        expect(detail?.items.length).toBe(1);
        expect(detail?.items[0]?.toolCall?.subtype).toBe("mcp");
      } finally {
        await service.shutdown();
      }
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("persists thread token usage updates in serialized snapshots", async () => {
    const ran = await withTempDatabase(async () => {
      const card = await createCard("codex", "in_progress", { title: "Thread token usage" });
      upsertCodexCardThreadLink({
        projectId: "codex",
        cardId: card.id,
        threadId: "thr_tokens",
      });

      const service = createService();
      const serviceInternals = service as unknown as {
        handleNotification: (method: string, params: unknown) => Promise<void>;
        on: (eventName: "event", listener: (event: CodexEvent) => void) => void;
      };
      const events: CodexEvent[] = [];

      serviceInternals.on("event", (event) => {
        events.push(event);
      });

      try {
        await serviceInternals.handleNotification("thread/tokenUsage/updated", {
          threadId: "thr_tokens",
          turnId: "turn_tokens",
          tokenUsage: {
            total: {
              totalTokens: 209_000,
              inputTokens: 180_000,
              cachedInputTokens: 12_000,
              outputTokens: 17_000,
              reasoningOutputTokens: 3_000,
            },
            last: {
              totalTokens: 209_000,
              inputTokens: 180_000,
              cachedInputTokens: 12_000,
              outputTokens: 17_000,
              reasoningOutputTokens: 3_000,
            },
            modelContextWindow: 258_000,
          },
        });

        const turnEvent = events.find(
          (event): event is Extract<CodexEvent, { type: "turn" }> => event.type === "turn",
        );
        expect(turnEvent?.turn.tokenUsage?.modelContextWindow).toBe(258_000);
        expect(turnEvent?.turn.tokenUsage?.last.totalTokens).toBe(209_000);

        const detail = service.serializeThreadDetail("thr_tokens");
        expect(detail?.turns[0]?.tokenUsage?.modelContextWindow).toBe(258_000);
        expect(detail?.turns[0]?.tokenUsage?.last.totalTokens).toBe(209_000);

        const rebooted = createService();
        try {
          const rehydrated = rebooted.serializeThreadDetail("thr_tokens");
          expect(rehydrated?.turns[0]?.tokenUsage?.modelContextWindow).toBe(258_000);
          expect(rehydrated?.turns[0]?.tokenUsage?.last.totalTokens).toBe(209_000);
        } finally {
          await rebooted.shutdown();
        }
      } finally {
        await service.shutdown();
      }
    });

    if (!ran) expect(true).toBeTrue();
  });
});

describe("codex-service interrupt target resolution", () => {
  test("interrupts the latest in-progress turn when turnId is omitted", async () => {
    const service = createService();
    const serviceInternals = service as unknown as {
      turnByThread: Map<string, Map<string, CodexTurnSummary>>;
      syncThreadStatusFromKnownTurns: (threadId: string) => void;
      persistThreadSnapshot: (threadId: string) => void;
    };
    const client = Reflect.get(service as object, "client") as {
      start: () => Promise<void>;
      request: (method: string, params: unknown) => Promise<unknown>;
    };
    const requests: Array<{ method: string; params: unknown }> = [];

    client.start = async () => undefined;
    client.request = async (method: string, params: unknown) => {
      requests.push({ method, params });
      return {};
    };
    serviceInternals.syncThreadStatusFromKnownTurns = () => {};
    serviceInternals.persistThreadSnapshot = () => {};

    serviceInternals.turnByThread.set(
      "thr_interrupt",
      new Map<string, CodexTurnSummary>([
        [
          "turn_completed",
          {
            threadId: "thr_interrupt",
            turnId: "turn_completed",
            status: "completed",
            itemIds: [],
          },
        ],
        [
          "turn_in_progress",
          {
            threadId: "thr_interrupt",
            turnId: "turn_in_progress",
            status: "inProgress",
            itemIds: [],
          },
        ],
      ]),
    );

    try {
      const result = await service.interruptTurn("thr_interrupt");
      expect(result).toBeTrue();
      expect(requests.length).toBe(1);
      expect(requests[0]?.method).toBe("turn/interrupt");
      expect((requests[0]?.params as { threadId?: string })?.threadId).toBe("thr_interrupt");
      expect((requests[0]?.params as { turnId?: string })?.turnId).toBe("turn_in_progress");
    } finally {
      await service.shutdown();
    }
  });

  test("prefers explicit turnId over inferred turn cache", async () => {
    const service = createService();
    const serviceInternals = service as unknown as {
      turnByThread: Map<string, Map<string, CodexTurnSummary>>;
      syncThreadStatusFromKnownTurns: (threadId: string) => void;
      persistThreadSnapshot: (threadId: string) => void;
    };
    const client = Reflect.get(service as object, "client") as {
      start: () => Promise<void>;
      request: (method: string, params: unknown) => Promise<unknown>;
    };
    const requests: Array<{ method: string; params: unknown }> = [];

    client.start = async () => undefined;
    client.request = async (method: string, params: unknown) => {
      requests.push({ method, params });
      return {};
    };
    serviceInternals.syncThreadStatusFromKnownTurns = () => {};
    serviceInternals.persistThreadSnapshot = () => {};

    serviceInternals.turnByThread.set(
      "thr_explicit",
      new Map<string, CodexTurnSummary>([
        [
          "turn_cached",
          {
            threadId: "thr_explicit",
            turnId: "turn_cached",
            status: "inProgress",
            itemIds: [],
          },
        ],
      ]),
    );

    try {
      const result = await service.interruptTurn("thr_explicit", "turn_explicit");
      expect(result).toBeTrue();
      expect(requests.length).toBe(1);
      expect(requests[0]?.method).toBe("turn/interrupt");
      expect((requests[0]?.params as { threadId?: string })?.threadId).toBe("thr_explicit");
      expect((requests[0]?.params as { turnId?: string })?.turnId).toBe("turn_explicit");
    } finally {
      await service.shutdown();
    }
  });

  test("throws when no interrupt target can be resolved", async () => {
    const service = createService();
    const client = Reflect.get(service as object, "client") as {
      start: () => Promise<void>;
      request: (method: string, params: unknown) => Promise<unknown>;
    };

    client.start = async () => undefined;
    client.request = async () => ({});
    service.readThread = async () => null;

    try {
      let failed = false;
      let message = "";
      try {
        await service.interruptTurn("thr_missing");
      } catch (error) {
        failed = true;
        message = error instanceof Error ? error.message : String(error);
      }

      expect(failed).toBeTrue();
      expect(message).toBe("Could not determine which turn to interrupt");
    } finally {
      await service.shutdown();
    }
  });
});

describe("codex-service startTurn", () => {
  test("resumes the thread and retries turn/start when thread is not loaded after app restart", async () => {
    const service = createService();
    const serviceInternals = service as unknown as {
      parseThreadRef: (threadId: string) => { projectId: string; cardId: string; cwd: string | null } | null;
      markThreadAsActive: (threadId: string) => void;
      persistThreadSnapshot: (threadId: string) => void;
    };
    const client = Reflect.get(service as object, "client") as {
      start: () => Promise<void>;
      request: (method: string, params: unknown) => Promise<unknown>;
    };
    const requests: Array<{ method: string; params: unknown }> = [];
    const markedActive: string[] = [];
    const persistedSnapshots: string[] = [];
    let turnStartAttempts = 0;

    serviceInternals.parseThreadRef = () => null;
    serviceInternals.markThreadAsActive = (threadId: string) => {
      markedActive.push(threadId);
    };
    serviceInternals.persistThreadSnapshot = (threadId: string) => {
      persistedSnapshots.push(threadId);
    };

    client.start = async () => undefined;
    client.request = async (method: string, params: unknown) => {
      requests.push({ method, params });

      if (method === "turn/start") {
        turnStartAttempts += 1;
        if (turnStartAttempts === 1) {
          throw new CodexRpcError("thread not found: thr_resume", -32600);
        }

        return {
          turn: {
            id: "turn_resumed",
            status: "in_progress",
            items: [],
          },
        };
      }

      if (method === "thread/resume") {
        return {};
      }

      if (method === "thread/read") {
        throw new Error("thread/read should not be called when turn/start returns a turn");
      }

      return {};
    };

    try {
      const startedTurn = await service.startTurn("thr_resume", "Continue");
      expect(startedTurn?.turnId).toBe("turn_resumed");
      expect(startedTurn?.status).toBe("inProgress");
      expect(turnStartAttempts).toBe(2);
      expect(requests.length).toBe(3);
      expect(requests[0]?.method).toBe("turn/start");
      expect(requests[1]?.method).toBe("thread/resume");
      expect((requests[1]?.params as { threadId?: string })?.threadId).toBe("thr_resume");
      expect(requests[2]?.method).toBe("turn/start");
      expect(markedActive.length).toBe(1);
      expect(markedActive[0]).toBe("thr_resume");
      expect(persistedSnapshots.length).toBe(1);
      expect(persistedSnapshots[0]).toBe("thr_resume");
    } finally {
      await service.shutdown();
    }
  });

  test("returns the immediate started turn payload without waiting for thread/read", async () => {
    const service = createService();
    const serviceInternals = service as unknown as {
      parseThreadRef: (threadId: string) => { projectId: string; cardId: string; cwd: string | null } | null;
      markThreadAsActive: (threadId: string) => void;
      persistThreadSnapshot: (threadId: string) => void;
    };
    const client = Reflect.get(service as object, "client") as {
      start: () => Promise<void>;
      request: (method: string, params: unknown) => Promise<unknown>;
    };
    const requests: Array<{ method: string; params: unknown }> = [];
    const markedActive: string[] = [];
    const persistedSnapshots: string[] = [];

    serviceInternals.parseThreadRef = () => null;
    serviceInternals.markThreadAsActive = (threadId: string) => {
      markedActive.push(threadId);
    };
    serviceInternals.persistThreadSnapshot = (threadId: string) => {
      persistedSnapshots.push(threadId);
    };

    client.start = async () => undefined;
    client.request = async (method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === "turn/start") {
        return {
          turn: {
            id: "turn_new",
            status: "in_progress",
            items: [],
          },
        };
      }
      if (method === "thread/read") {
        throw new Error("thread/read should not be called when turn/start returns a turn");
      }
      return {};
    };

    try {
      const startedTurn = await service.startTurn("thr_start", "Ship the fix");
      expect(startedTurn?.turnId).toBe("turn_new");
      expect(startedTurn?.status).toBe("inProgress");
      expect(requests.length).toBe(1);
      expect(requests[0]?.method).toBe("turn/start");
      expect(markedActive.length).toBe(1);
      expect(markedActive[0]).toBe("thr_start");
      expect(persistedSnapshots.length).toBe(1);
      expect(persistedSnapshots[0]).toBe("thr_start");
    } finally {
      await service.shutdown();
    }
  });

  test("seeds an optimistic user message as soon as turn/start returns a turn", async () => {
    const ran = await withTempDatabase(async () => {
      const card = await createCard("codex", "in_progress", { title: "Optimistic follow-up prompt" });
      upsertCodexCardThreadLink({
        projectId: "codex",
        cardId: card.id,
        threadId: "thr_start_prompt",
      });

      const service = createService();
      const serviceInternals = service as unknown as {
        on: (eventName: "event", listener: (event: CodexEvent) => void) => void;
      };
      const client = Reflect.get(service as object, "client") as {
        start: () => Promise<void>;
        request: (method: string, params: unknown) => Promise<unknown>;
      };
      const events: CodexEvent[] = [];

      serviceInternals.on("event", (event) => {
        events.push(event);
      });

      client.start = async () => undefined;
      client.request = async (method: string) => {
        if (method === "turn/start") {
          return {
            turn: {
              id: "turn_prompt",
              status: "in_progress",
              items: [],
            },
          };
        }
        throw new Error(`Unexpected method: ${method}`);
      };

      try {
        const startedTurn = await service.startTurn("thr_start_prompt", "Ship the fix");
        const detail = service.serializeThreadDetail("thr_start_prompt");
        const promptItem = detail?.items[0];
        const itemUpsertEvent = events.find((event) => event.type === "itemUpsert") as
          | { type: "itemUpsert"; item: CodexItemView }
          | undefined;

        expect(startedTurn?.turnId).toBe("turn_prompt");
        expect(detail).not.toBeNull();
        expect(detail?.turns[0]?.itemIds.length).toBe(1);
        expect(promptItem?.normalizedKind).toBe("userMessage");
        expect(promptItem?.role).toBe("user");
        expect(promptItem?.markdownText).toBe("Ship the fix");
        expect(Boolean(promptItem?.itemId.startsWith("item-"))).toBeTrue();
        expect(itemUpsertEvent?.item.markdownText).toBe("Ship the fix");
      } finally {
        await service.shutdown();
      }
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("seeds an optimistic user message as soon as turn/steer is accepted", async () => {
    const ran = await withTempDatabase(async () => {
      const card = await createCard("codex", "in_progress", { title: "Optimistic steering prompt" });
      upsertCodexCardThreadLink({
        projectId: "codex",
        cardId: card.id,
        threadId: "thr_steer_prompt",
      });
      upsertCodexThreadSnapshot({
        threadId: "thr_steer_prompt",
        turns: [
          {
            threadId: "thr_steer_prompt",
            turnId: "turn_steer_prompt",
            status: "inProgress",
            itemIds: [],
          },
        ],
        items: [],
        updatedAt: 2,
      });

      const service = createService();
      const serviceInternals = service as unknown as {
        on: (eventName: "event", listener: (event: CodexEvent) => void) => void;
      };
      const client = Reflect.get(service as object, "client") as {
        start: () => Promise<void>;
        request: (method: string, params: unknown) => Promise<unknown>;
      };
      const events: CodexEvent[] = [];

      serviceInternals.on("event", (event) => {
        events.push(event);
      });

      client.start = async () => undefined;
      client.request = async (method: string) => {
        if (method === "turn/steer") {
          return { turnId: "turn_steer_prompt" };
        }
        throw new Error(`Unexpected method: ${method}`);
      };

      try {
        const steeredTurn = await service.steerTurn(
          "thr_steer_prompt",
          "turn_steer_prompt",
          "Tighten the layout.",
          "item-4242",
        );
        const detail = service.serializeThreadDetail("thr_steer_prompt");
        const promptItem = detail?.items[0];
        const itemUpsertEvent = events.find((event) => event.type === "itemUpsert") as
          | { type: "itemUpsert"; item: CodexItemView }
          | undefined;

        expect(steeredTurn?.turnId).toBe("turn_steer_prompt");
        expect(detail).not.toBeNull();
        expect(detail?.turns[0]?.itemIds.length).toBe(1);
        expect(promptItem?.normalizedKind).toBe("userMessage");
        expect(promptItem?.role).toBe("user");
        expect(promptItem?.itemId).toBe("item-4242");
        expect(promptItem?.markdownText).toBe("Tighten the layout.");
        expect(itemUpsertEvent?.item.markdownText).toBe("Tighten the layout.");
      } finally {
        await service.shutdown();
      }
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("passes model and reasoning overrides through to turn/start", async () => {
    const service = createService();
    const serviceInternals = service as unknown as {
      parseThreadRef: (threadId: string) => { projectId: string; cardId: string; cwd: string | null } | null;
      parseWorkspacePath: (projectId: string) => string;
      markThreadAsActive: (threadId: string) => void;
      persistThreadSnapshot: (threadId: string) => void;
    };
    const client = Reflect.get(service as object, "client") as {
      start: () => Promise<void>;
      request: (method: string, params: unknown) => Promise<unknown>;
    };
    const requests: Array<{ method: string; params: unknown }> = [];

    serviceInternals.parseThreadRef = () => ({ projectId: "codex", cardId: "card-1", cwd: null });
    serviceInternals.parseWorkspacePath = () => "/tmp/codex";
    serviceInternals.markThreadAsActive = () => {};
    serviceInternals.persistThreadSnapshot = () => {};

    client.start = async () => undefined;
    client.request = async (method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === "turn/start") {
        return {
          turn: {
            id: "turn_override",
            status: "in_progress",
            items: [],
          },
        };
      }
      return {};
    };

    try {
      const startedTurn = await service.startTurn("thr_start", "Ship the fix", {
        model: "gpt-5.3-codex",
        permissionMode: "sandbox",
        reasoningEffort: "high",
      });
      expect(startedTurn?.turnId).toBe("turn_override");
      expect(requests.length).toBe(1);
      expect(requests[0]?.method).toBe("turn/start");
      expect((requests[0]?.params as { model?: string })?.model).toBe("gpt-5.3-codex");
      expect((requests[0]?.params as { effort?: string })?.effort).toBe("high");
      expect((requests[0]?.params as { approvalPolicy?: string })?.approvalPolicy).toBe("on-request");
      expect((requests[0]?.params as { cwd?: string })?.cwd).toBe("/tmp/codex");
      expect(JSON.stringify((requests[0]?.params as {
        sandboxPolicy?: {
          type?: string;
          writableRoots?: string[];
          readOnlyAccess?: { type?: string; includePlatformDefaults?: boolean; readableRoots?: string[] };
          networkAccess?: boolean;
          excludeTmpdirEnvVar?: boolean;
          excludeSlashTmp?: boolean;
        };
      })?.sandboxPolicy)).toBe(JSON.stringify({
        type: "workspaceWrite",
        writableRoots: ["/tmp/codex"],
        readOnlyAccess: {
          type: "fullAccess",
        },
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      }));
    } finally {
      await service.shutdown();
    }
  });

  test("includes collaborationMode payload for plan turns", async () => {
    const service = createService();
    const serviceInternals = service as unknown as {
      parseThreadRef: (threadId: string) => { projectId: string; cardId: string; cwd: string | null } | null;
      parseWorkspacePath: (projectId: string) => string;
      markThreadAsActive: (threadId: string) => void;
      persistThreadSnapshot: (threadId: string) => void;
    };
    const client = Reflect.get(service as object, "client") as {
      start: () => Promise<void>;
      request: (method: string, params: unknown) => Promise<unknown>;
    };
    const requests: Array<{ method: string; params: unknown }> = [];

    serviceInternals.parseThreadRef = () => ({ projectId: "codex", cardId: "card-1", cwd: null });
    serviceInternals.parseWorkspacePath = () => "/tmp/codex";
    serviceInternals.markThreadAsActive = () => {};
    serviceInternals.persistThreadSnapshot = () => {};

    client.start = async () => undefined;
    client.request = async (method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === "turn/start") {
        return {
          turn: {
            id: "turn_plan_mode",
            status: "in_progress",
            items: [],
          },
        };
      }
      return {};
    };

    try {
      const startedTurn = await service.startTurn("thr_start", "Plan this task", {
        model: "gpt-5.3-codex",
        reasoningEffort: "high",
        permissionMode: "sandbox",
        collaborationMode: "plan",
      });
      expect(startedTurn?.turnId).toBe("turn_plan_mode");
      expect(requests.length).toBe(1);
      expect(JSON.stringify((requests[0]?.params as { collaborationMode?: unknown })?.collaborationMode)).toBe(
        JSON.stringify({
          mode: "plan",
          settings: {
            model: "gpt-5.3-codex",
            reasoning_effort: "high",
            developer_instructions: null,
          },
        }),
      );
    } finally {
      await service.shutdown();
    }
  });

  test("uses the linked thread cwd for follow-up turns", async () => {
    const service = createService();
    const serviceInternals = service as unknown as {
      parseThreadRef: (threadId: string) => { projectId: string; cardId: string; cwd: string | null } | null;
      parseWorkspacePath: (projectId: string) => string;
      markThreadAsActive: (threadId: string) => void;
      persistThreadSnapshot: (threadId: string) => void;
    };
    const client = Reflect.get(service as object, "client") as {
      start: () => Promise<void>;
      request: (method: string, params: unknown) => Promise<unknown>;
    };
    const requests: Array<{ method: string; params: unknown }> = [];

    serviceInternals.parseThreadRef = () => ({
      projectId: "codex",
      cardId: "card-1",
      cwd: "/tmp/codex/worktrees/abcd/codex",
    });
    serviceInternals.parseWorkspacePath = () => {
      throw new Error("parseWorkspacePath should not be called when a linked cwd exists");
    };
    serviceInternals.markThreadAsActive = () => {};
    serviceInternals.persistThreadSnapshot = () => {};

    client.start = async () => undefined;
    client.request = async (method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === "turn/start") {
        return {
          turn: {
            id: "turn_worktree",
            status: "in_progress",
            items: [],
          },
        };
      }
      return {};
    };

    try {
      const startedTurn = await service.startTurn("thr_start", "Continue in worktree", {
        permissionMode: "sandbox",
      });
      expect(startedTurn?.turnId).toBe("turn_worktree");
      expect(requests.length).toBe(1);
      expect((requests[0]?.params as { cwd?: string })?.cwd).toBe("/tmp/codex/worktrees/abcd/codex");
    } finally {
      await service.shutdown();
    }
  });

  test("passes full-access permission overrides through to turn/start", async () => {
    const service = createService();
    const serviceInternals = service as unknown as {
      parseThreadRef: (threadId: string) => { projectId: string; cardId: string; cwd: string | null } | null;
      markThreadAsActive: (threadId: string) => void;
      persistThreadSnapshot: (threadId: string) => void;
    };
    const client = Reflect.get(service as object, "client") as {
      start: () => Promise<void>;
      request: (method: string, params: unknown) => Promise<unknown>;
    };
    const requests: Array<{ method: string; params: unknown }> = [];

    serviceInternals.parseThreadRef = () => null;
    serviceInternals.markThreadAsActive = () => {};
    serviceInternals.persistThreadSnapshot = () => {};

    client.start = async () => undefined;
    client.request = async (method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === "turn/start") {
        return {
          turn: {
            id: "turn_full_access",
            status: "in_progress",
            items: [],
          },
        };
      }
      return {};
    };

    try {
      const startedTurn = await service.startTurn("thr_start", "Ship the fix", {
        permissionMode: "full-access",
      });
      expect(startedTurn?.turnId).toBe("turn_full_access");
      expect(requests.length).toBe(1);
      expect((requests[0]?.params as { approvalPolicy?: string })?.approvalPolicy).toBe("never");
      expect(JSON.stringify((requests[0]?.params as { sandboxPolicy?: { type?: string } })?.sandboxPolicy)).toBe(JSON.stringify({
        type: "dangerFullAccess",
      }));
    } finally {
      await service.shutdown();
    }
  });

  test("omits explicit permission overrides for custom mode", async () => {
    const service = createService();
    const serviceInternals = service as unknown as {
      parseThreadRef: (threadId: string) => { projectId: string; cardId: string; cwd: string | null } | null;
      markThreadAsActive: (threadId: string) => void;
      persistThreadSnapshot: (threadId: string) => void;
    };
    const client = Reflect.get(service as object, "client") as {
      start: () => Promise<void>;
      request: (method: string, params: unknown) => Promise<unknown>;
    };
    const requests: Array<{ method: string; params: unknown }> = [];

    serviceInternals.parseThreadRef = () => null;
    serviceInternals.markThreadAsActive = () => {};
    serviceInternals.persistThreadSnapshot = () => {};

    client.start = async () => undefined;
    client.request = async (method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === "turn/start") {
        return {
          turn: {
            id: "turn_custom",
            status: "in_progress",
            items: [],
          },
        };
      }
      return {};
    };

    try {
      const startedTurn = await service.startTurn("thr_start", "Ship the fix", {
        permissionMode: "custom",
      });
      expect(startedTurn?.turnId).toBe("turn_custom");
      expect(requests.length).toBe(1);
      expect((requests[0]?.params as { approvalPolicy?: unknown })?.approvalPolicy).toBe(undefined);
      expect((requests[0]?.params as { sandboxPolicy?: unknown })?.sandboxPolicy).toBe(undefined);
    } finally {
      await service.shutdown();
    }
  });
});

describe("codex-service collaboration modes", () => {
  test("parses collaborationMode/list response and filters unsupported modes", async () => {
    const service = createService();
    const client = Reflect.get(service as object, "client") as {
      start: () => Promise<void>;
      request: (method: string, params: unknown) => Promise<unknown>;
    };

    client.start = async () => undefined;
    client.request = async (method: string) => {
      if (method !== "collaborationMode/list") return {};
      return {
        data: [
          {
            name: "Default",
            mode: "default",
            model: "gpt-5.3-codex",
            reasoning_effort: "high",
          },
          {
            name: "Plan",
            mode: "plan",
            model: "gpt-5.3-codex",
            reasoningEffort: null,
          },
          {
            name: "Ignored",
            mode: "research",
            model: "gpt-5.3-codex",
            reasoning_effort: "low",
          },
        ],
      };
    };

    try {
      const presets = await service.listCollaborationModes();
      expect(presets.length).toBe(2);
      expect(JSON.stringify(presets)).toBe(JSON.stringify([
        {
          name: "Default",
          mode: "default",
          model: "gpt-5.3-codex",
          reasoningEffort: "high",
        },
        {
          name: "Plan",
          mode: "plan",
          model: "gpt-5.3-codex",
          reasoningEffort: null,
        },
      ]));
    } finally {
      await service.shutdown();
    }
  });
});

describe("codex-service startThreadForCard", () => {
  test("generates thread title through structured thread/start and turn/start flow", async () => {
    const service = createService();
    const serviceInternals = service as unknown as {
      threadTitlePromptTemplate: string | null | undefined;
      generateThreadTitleWithStructuredTurn: (input: {
        prompt: string;
        cwd: string | null;
        client: {
          startThread: (params: Record<string, unknown>) => Promise<unknown>;
          startTurn: (params: Record<string, unknown>) => Promise<unknown>;
          interruptTurn: (params: { threadId: string; turnId: string }) => Promise<unknown>;
          onNotification: (handler: (notification: { method: string; params: unknown }) => void) => () => void;
        };
      }) => Promise<string | null>;
    };
    let notificationHandler: ((notification: { method: string; params: unknown }) => void) | null = null;
    let threadStartParams: Record<string, unknown> | null = null;
    let turnStartParams: Record<string, unknown> | null = null;
    serviceInternals.threadTitlePromptTemplate = "<USER_PROMPT>";

    const mockClient = {
      startThread: async (params: Record<string, unknown>) => {
        threadStartParams = params;
        return { thread: { id: "thr_title_1" } };
      },
      startTurn: async (params: Record<string, unknown>) => {
        turnStartParams = params;
        setTimeout(() => {
          notificationHandler?.({
            method: "turn/started",
            params: { threadId: "thr_title_1", turnId: "turn_title_1" },
          });
          notificationHandler?.({
            method: "item/agentMessage/delta",
            params: {
              threadId: "thr_title_1",
              turnId: "turn_title_1",
              delta: "{\"title\":\"Refactor inbox list layout\"}",
            },
          });
          notificationHandler?.({
            method: "turn/completed",
            params: { threadId: "thr_title_1", turnId: "turn_title_1", status: "completed" },
          });
        }, 0);
        return { turn: { id: "turn_title_1" } };
      },
      interruptTurn: async () => ({}),
      onNotification: (handler: (notification: { method: string; params: unknown }) => void) => {
        notificationHandler = handler;
        return () => {
          notificationHandler = null;
        };
      },
    };

    try {
      const generated = await serviceInternals.generateThreadTitleWithStructuredTurn({
        prompt: "Refactor inbox list layout",
        cwd: "/tmp/codex",
        client: mockClient,
      });
      expect(generated).toBe("Refactor inbox list layout");
      expect(JSON.stringify(threadStartParams)).toBe(JSON.stringify({
        model: "gpt-5.1-codex-mini",
        modelProvider: null,
        cwd: "/tmp/codex",
        approvalPolicy: "never",
        sandbox: "read-only",
        config: {
          web_search: "disabled",
          model_reasoning_effort: "low",
        },
        baseInstructions: null,
        developerInstructions: null,
        personality: null,
        ephemeral: true,
        experimentalRawEvents: false,
        dynamicTools: null,
        persistExtendedHistory: false,
      }));

      expect(JSON.stringify(turnStartParams)).toBe(JSON.stringify({
        threadId: "thr_title_1",
        input: [{ type: "text", text: "Refactor inbox list layout", text_elements: [] }],
        cwd: null,
        approvalPolicy: null,
        sandboxPolicy: null,
        model: null,
        effort: null,
        summary: "auto",
        personality: null,
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["title"],
          properties: {
            title: {
              type: "string",
              minLength: 18,
              maxLength: 36,
            },
          },
        },
        collaborationMode: null,
      }));
    } finally {
      await service.shutdown();
    }
  });

  test("normalizes title text and truncates input prompt before sending", async () => {
    const service = createService();
    const serviceInternals = service as unknown as {
      threadTitlePromptTemplate: string | null | undefined;
      generateThreadTitleWithStructuredTurn: (input: {
        prompt: string;
        cwd: string | null;
        client: {
          startThread: (params: Record<string, unknown>) => Promise<unknown>;
          startTurn: (params: Record<string, unknown>) => Promise<unknown>;
          interruptTurn: (params: { threadId: string; turnId: string }) => Promise<unknown>;
          onNotification: (handler: (notification: { method: string; params: unknown }) => void) => () => void;
        };
      }) => Promise<string | null>;
    };
    let notificationHandler: ((notification: { method: string; params: unknown }) => void) | null = null;
    let turnStartParams: Record<string, unknown> | null = null;
    const longPrompt = "x".repeat(2_500);
    serviceInternals.threadTitlePromptTemplate = "Title source:\n<USER_PROMPT>";

    const mockClient = {
      startThread: async () => ({ thread: { id: "thr_title_2" } }),
      startTurn: async (params: Record<string, unknown>) => {
        turnStartParams = params;
        setTimeout(() => {
          notificationHandler?.({
            method: "item/agentMessage/delta",
            params: {
              threadId: "other_thread",
              turnId: "other_turn",
              delta: "wrong stream",
            },
          });
          notificationHandler?.({
            method: "item/agentMessage/delta",
            params: {
              threadId: "thr_title_2",
              turnId: "turn_title_2",
              delta: "{\"title\":\"This should be replaced\"}",
            },
          });
          notificationHandler?.({
            method: "item/completed",
            params: {
              threadId: "thr_title_2",
              turnId: "turn_title_2",
              item: {
                type: "agentMessage",
                text: "title: \"Fix flaky test timing issue.\"",
              },
            },
          });
          notificationHandler?.({
            method: "turn/completed",
            params: { threadId: "thr_title_2", turnId: "turn_title_2", status: "completed" },
          });
        }, 0);
        return { turn: { id: "turn_title_2" } };
      },
      interruptTurn: async () => ({}),
      onNotification: (handler: (notification: { method: string; params: unknown }) => void) => {
        notificationHandler = handler;
        return () => {
          notificationHandler = null;
        };
      },
    };

    try {
      const generated = await serviceInternals.generateThreadTitleWithStructuredTurn({
        prompt: longPrompt,
        cwd: "/tmp/codex",
        client: mockClient,
      });
      expect(generated).toBe("Fix flaky test timing issue");

      const turnStartPayload = turnStartParams && typeof turnStartParams === "object"
        ? turnStartParams as { input?: Array<{ text?: string }> }
        : {};
      const generatedPrompt = turnStartPayload.input?.[0]?.text ?? "";
      expect(generatedPrompt.startsWith("Title source:\n")).toBeTrue();
      const promptBody = generatedPrompt.replace("Title source:\n", "");
      expect(promptBody.length).toBe(2_000);
    } finally {
      await service.shutdown();
    }
  });

  test("ignores unrelated notifications before the helper thread starts", async () => {
    const service = createService();
    const serviceInternals = service as unknown as {
      threadTitlePromptTemplate: string | null | undefined;
      generateThreadTitleWithStructuredTurn: (input: {
        prompt: string;
        cwd: string | null;
        client: {
          startThread: (params: Record<string, unknown>) => Promise<unknown>;
          startTurn: (params: Record<string, unknown>) => Promise<unknown>;
          interruptTurn: (params: { threadId: string; turnId: string }) => Promise<unknown>;
          onNotification: (handler: (notification: { method: string; params: unknown }) => void) => () => void;
        };
      }) => Promise<string | null>;
    };
    let notificationHandler: ((notification: { method: string; params: unknown }) => void) | null = null;
    serviceInternals.threadTitlePromptTemplate = "<USER_PROMPT>";

    const mockClient = {
      startThread: async () => ({ thread: { id: "thr_title_3" } }),
      startTurn: async () => {
        setTimeout(() => {
          notificationHandler?.({
            method: "turn/completed",
            params: { threadId: "other_thread", turnId: "other_turn", status: "completed" },
          });
          notificationHandler?.({
            method: "turn/started",
            params: { threadId: "thr_title_3", turnId: "turn_title_3" },
          });
          notificationHandler?.({
            method: "item/agentMessage/delta",
            params: {
              threadId: "thr_title_3",
              turnId: "turn_title_3",
              delta: "{\"title\":\"Fix worktree startup race\"}",
            },
          });
          notificationHandler?.({
            method: "turn/completed",
            params: { threadId: "thr_title_3", turnId: "turn_title_3", status: "completed" },
          });
        }, 0);
        return { turn: { id: "turn_title_3" } };
      },
      interruptTurn: async () => ({}),
      onNotification: (handler: (notification: { method: string; params: unknown }) => void) => {
        notificationHandler = handler;
        return () => {
          notificationHandler = null;
        };
      },
    };

    try {
      const generated = await serviceInternals.generateThreadTitleWithStructuredTurn({
        prompt: "Fix worktree startup race",
        cwd: "/tmp/codex",
        client: mockClient,
      });
      expect(generated).toBe("Fix worktree startup race");
    } finally {
      await service.shutdown();
    }
  });

  test("includes collaborationMode payload in the initial turn/start request", async () => {
    const ran = await withTempDatabase(async () => {
      const card = await createCard("codex", "in_progress", { title: "Plan mode start thread" });
      const service = createService();
      const client = Reflect.get(service as object, "client") as {
        start: () => Promise<void>;
        request: (method: string, params: unknown) => Promise<unknown>;
      };
      const requests: Array<{ method: string; params: unknown }> = [];

      service.readThreadAfterStart = async () => ({
        threadId: "thr_plan_mode",
        projectId: "codex",
        cardId: card.id,
        threadName: null,
        threadPreview: "",
        modelProvider: "openai",
        cwd: "/tmp/codex",
        statusType: "active",
        statusActiveFlags: [],
        archived: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        linkedAt: new Date().toISOString(),
        turns: [],
        items: [],
      });

      client.start = async () => undefined;
      client.request = async (method: string, params: unknown) => {
        requests.push({ method, params });
        if (method === "thread/start") {
          return {
            thread: {
              id: "thr_plan_mode",
              modelProvider: "openai",
              cwd: "/tmp/codex",
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          };
        }
        if (method === "turn/start") {
          return {
            turn: {
              id: "turn_plan_mode",
              status: "in_progress",
              items: [],
            },
          };
        }
        return {};
      };

      try {
        await service.startThreadForCard({
          projectId: "codex",
          cardId: card.id,
          prompt: "Ask clarifying questions first",
          model: "gpt-5.3-codex",
          reasoningEffort: "medium",
          collaborationMode: "plan",
          permissionMode: "sandbox",
        });

        const turnStartRequest = requests.find((request) => request.method === "turn/start");
        expect(turnStartRequest).not.toBeNull();
        expect(JSON.stringify((turnStartRequest?.params as { collaborationMode?: unknown })?.collaborationMode)).toBe(
          JSON.stringify({
            mode: "plan",
            settings: {
              model: "gpt-5.3-codex",
              reasoning_effort: "medium",
              developer_instructions: null,
            },
          }),
        );
      } finally {
        await service.shutdown();
      }
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("queues auto title generation when no explicit thread name is provided", async () => {
    const ran = await withTempDatabase(async () => {
      const card = await createCard("codex", "in_progress", { title: "Auto title thread" });
      const service = createService();
      const serviceInternals = service as unknown as {
        queueGeneratedThreadTitle: (input: { threadId: string; firstPrompt: string; cwd: string }) => void;
      };
      const client = Reflect.get(service as object, "client") as {
        start: () => Promise<void>;
        request: (method: string, params: unknown) => Promise<unknown>;
      };
      const queued: Array<{ threadId: string; firstPrompt: string; cwd: string }> = [];

      serviceInternals.queueGeneratedThreadTitle = (input) => {
        queued.push(input);
      };

      client.start = async () => undefined;
      client.request = async (method: string) => {
        if (method === "thread/start") {
          return {
            thread: {
              id: "thr_auto_title",
              modelProvider: "openai",
              cwd: "/tmp/codex",
              createdAt: 1,
              updatedAt: 1,
            },
          };
        }
        if (method === "turn/start") {
          return {
            turn: {
              id: "turn_auto_title",
              status: "in_progress",
              items: [],
            },
          };
        }
        return {};
      };

      service.readThreadAfterStart = async () => ({
        threadId: "thr_auto_title",
        projectId: "codex",
        cardId: card.id,
        threadName: null,
        threadPreview: "",
        modelProvider: "openai",
        cwd: "/tmp/codex",
        statusType: "active",
        statusActiveFlags: [],
        archived: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        linkedAt: new Date().toISOString(),
        turns: [],
        items: [],
      });

      try {
        await service.startThreadForCard({
          projectId: "codex",
          cardId: card.id,
          prompt: "Generate a title for this thread",
          permissionMode: "sandbox",
        });
        expect(queued.length).toBe(1);
        expect(queued[0]?.threadId).toBe("thr_auto_title");
        expect(queued[0]?.firstPrompt).toBe("Generate a title for this thread");
        expect(queued[0]?.cwd).toBe("/tmp/codex");
      } finally {
        await service.shutdown();
      }
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("skips auto title generation when an explicit thread name is provided", async () => {
    const ran = await withTempDatabase(async () => {
      const card = await createCard("codex", "in_progress", { title: "Named thread" });
      const service = createService();
      const serviceInternals = service as unknown as {
        queueGeneratedThreadTitle: (input: { threadId: string; firstPrompt: string; cwd: string }) => void;
      };
      const client = Reflect.get(service as object, "client") as {
        start: () => Promise<void>;
        request: (method: string, params: unknown) => Promise<unknown>;
      };
      let queuedCount = 0;
      const requestMethods: string[] = [];

      serviceInternals.queueGeneratedThreadTitle = () => {
        queuedCount += 1;
      };

      client.start = async () => undefined;
      client.request = async (method: string, params: unknown) => {
        requestMethods.push(method);
        if (method === "thread/start") {
          return {
            thread: {
              id: "thr_explicit_name",
              modelProvider: "openai",
              cwd: "/tmp/codex",
              createdAt: 1,
              updatedAt: 1,
            },
          };
        }
        if (method === "turn/start") {
          return {
            turn: {
              id: "turn_explicit_name",
              status: "in_progress",
              items: [],
            },
          };
        }
        if (method === "thread/name/set") {
          expect((params as { name?: string })?.name).toBe("My explicit thread");
        }
        return {};
      };

      service.readThreadAfterStart = async () => ({
        threadId: "thr_explicit_name",
        projectId: "codex",
        cardId: card.id,
        threadName: "My explicit thread",
        threadPreview: "",
        modelProvider: "openai",
        cwd: "/tmp/codex",
        statusType: "active",
        statusActiveFlags: [],
        archived: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        linkedAt: new Date().toISOString(),
        turns: [],
        items: [],
      });

      try {
        await service.startThreadForCard({
          projectId: "codex",
          cardId: card.id,
          prompt: "Thread prompt",
          threadName: "My explicit thread",
          permissionMode: "sandbox",
        });
        expect(requestMethods.includes("thread/name/set")).toBeTrue();
        expect(queuedCount).toBe(0);
      } finally {
        await service.shutdown();
      }
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("applies model and reasoning overrides to the first turn", async () => {
    const ran = await withTempDatabase(async () => {
      const card = await createCard("codex", "in_progress", { title: "Start thread" });
      const service = createService();
      const client = Reflect.get(service as object, "client") as {
        start: () => Promise<void>;
        request: (method: string, params: unknown) => Promise<unknown>;
      };
      const requests: Array<{ method: string; params: unknown }> = [];

      const expectedDetail: CodexThreadDetail = {
        threadId: "thr_created",
        projectId: "codex",
        cardId: card.id,
        threadName: "Thread",
        threadPreview: "",
        modelProvider: "openai",
        cwd: "/tmp/codex",
        statusType: "active",
        statusActiveFlags: [],
        archived: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        linkedAt: new Date().toISOString(),
        turns: [],
        items: [],
      };

      client.start = async () => undefined;
      client.request = async (method: string, params: unknown) => {
        requests.push({ method, params });
        if (method === "thread/start") {
          return {
            thread: {
              id: "thr_created",
              modelProvider: "openai",
              cwd: "/tmp/codex",
              createdAt: 1,
              updatedAt: 1,
            },
          };
        }
        if (method === "turn/start") {
          return {
            turn: {
              id: "turn_created",
              status: "in_progress",
              items: [],
            },
          };
        }
        return {};
      };

      service.readThreadAfterStart = async () => expectedDetail;

      try {
        const detail = await service.startThreadForCard({
          projectId: "codex",
          cardId: card.id,
          prompt: "Build it",
          threadName: "Thread",
          model: "gpt-5.3-codex",
          permissionMode: "full-access",
          reasoningEffort: "high",
        });
        expect(detail).toBe(expectedDetail);
        expect(requests.length).toBe(2);
        expect(requests[0]?.method).toBe("thread/start");
        expect((requests[0]?.params as { model?: string })?.model).toBe("gpt-5.3-codex");
        expect(requests[1]?.method).toBe("turn/start");
        expect((requests[1]?.params as { model?: string })?.model).toBe("gpt-5.3-codex");
        expect((requests[1]?.params as { effort?: string })?.effort).toBe("high");
        expect((requests[1]?.params as { approvalPolicy?: string })?.approvalPolicy).toBe("never");
        expect(JSON.stringify((requests[1]?.params as { sandboxPolicy?: { type?: string } })?.sandboxPolicy)).toBe(JSON.stringify({
          type: "dangerFullAccess",
        }));
      } finally {
        await service.shutdown();
      }
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("seeds the first prompt into a new thread before live transcript items arrive", async () => {
    const ran = await withTempDatabase(async () => {
      const card = await createCard("codex", "in_progress", {
        title: "Optimistic first prompt",
      });
      const service = createService();
      const serviceInternals = service as unknown as {
        on: (eventName: "event", listener: (event: CodexEvent) => void) => void;
      };
      const client = Reflect.get(service as object, "client") as {
        start: () => Promise<void>;
        request: (method: string, params: unknown) => Promise<unknown>;
      };
      const events: CodexEvent[] = [];

      service.readThreadAfterStart = async (threadId: string) => service.serializeThreadDetail(threadId);

      serviceInternals.on("event", (event) => {
        events.push(event);
      });

      client.start = async () => undefined;
      client.request = async (method: string) => {
        if (method === "thread/start") {
          return {
            thread: {
              id: "thr_created_prompt",
              modelProvider: "openai",
              cwd: "/tmp/codex",
              createdAt: 1,
              updatedAt: 1,
            },
          };
        }
        if (method === "thread/name/set") {
          return {};
        }
        if (method === "turn/start") {
          return {
            turn: {
              id: "turn_created_prompt",
              status: "in_progress",
              items: [],
            },
          };
        }
        throw new Error(`Unexpected method: ${method}`);
      };

      try {
        const detail = await service.startThreadForCard({
          projectId: "codex",
          cardId: card.id,
          prompt: "Build it",
          threadName: "Thread",
        });
        const promptItem = detail.items[0];
        const itemUpsertEvent = events.find((event) => event.type === "itemUpsert") as
          | { type: "itemUpsert"; item: CodexItemView }
          | undefined;

        expect(detail.threadId).toBe("thr_created_prompt");
        expect(detail.turns[0]?.turnId).toBe("turn_created_prompt");
        expect(detail.turns[0]?.itemIds.length).toBe(1);
        expect(promptItem?.normalizedKind).toBe("userMessage");
        expect(promptItem?.markdownText).toBe("Build it");
        expect(Boolean(promptItem?.itemId.startsWith("item-"))).toBeTrue();
        expect(itemUpsertEvent?.item.markdownText).toBe("Build it");
      } finally {
        await service.shutdown();
      }
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("persists fallback cwd and uses local run-in override when thread payload omits cwd", async () => {
    const ran = await withTempDatabase(async () => {
      const localRunPath = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-local-run-"));
      const card = await createCard("codex", "in_progress", {
        title: "Start thread local override",
        runInTarget: "localProject",
        runInLocalPath: localRunPath,
      });
      const service = createService();
      const client = Reflect.get(service as object, "client") as {
        start: () => Promise<void>;
        request: (method: string, params: unknown) => Promise<unknown>;
      };
      const requests: Array<{ method: string; params: unknown }> = [];

      const expectedDetail: CodexThreadDetail = {
        threadId: "thr_local_override",
        projectId: "codex",
        cardId: card.id,
        threadName: "Thread",
        threadPreview: "",
        modelProvider: "openai",
        cwd: localRunPath,
        statusType: "active",
        statusActiveFlags: [],
        archived: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        linkedAt: new Date().toISOString(),
        turns: [],
        items: [],
      };

      client.start = async () => undefined;
      client.request = async (method: string, params: unknown) => {
        requests.push({ method, params });
        if (method === "thread/start") {
          return {
            thread: {
              id: "thr_local_override",
              modelProvider: "openai",
              createdAt: 1,
              updatedAt: 1,
            },
          };
        }
        if (method === "turn/start") {
          return {
            turn: {
              id: "turn_local_override",
              status: "in_progress",
              items: [],
            },
          };
        }
        return {};
      };

      service.readThreadAfterStart = async () => expectedDetail;

      try {
        const detail = await service.startThreadForCard({
          projectId: "codex",
          cardId: card.id,
          prompt: "Build it",
          threadName: "Thread",
          permissionMode: "sandbox",
        });
        expect(detail).toBe(expectedDetail);
        expect((requests[0]?.params as { cwd?: string })?.cwd).toBe(localRunPath);
        expect((requests[1]?.params as { cwd?: string })?.cwd).toBe(localRunPath);
        const link = getCodexCardThreadLink("thr_local_override");
        expect(link?.cwd).toBe(localRunPath);
      } finally {
        await service.shutdown();
        fs.rmSync(localRunPath, { recursive: true, force: true });
      }
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("reuses persisted managed worktree path for new-worktree cards", async () => {
    const ran = await withTempDatabase(async () => {
      const managedWorktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-managed-worktree-"));
      const card = await createCard("codex", "in_progress", {
        title: "Reuse managed worktree path",
        runInTarget: "newWorktree",
        runInWorktreePath: managedWorktreePath,
      });
      const service = createService();
      const client = Reflect.get(service as object, "client") as {
        start: () => Promise<void>;
        request: (method: string, params: unknown) => Promise<unknown>;
      };
      const requests: Array<{ method: string; params: unknown }> = [];

      const expectedDetail: CodexThreadDetail = {
        threadId: "thr_reuse_worktree",
        projectId: "codex",
        cardId: card.id,
        threadName: "Thread",
        threadPreview: "",
        modelProvider: "openai",
        cwd: managedWorktreePath,
        statusType: "active",
        statusActiveFlags: [],
        archived: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        linkedAt: new Date().toISOString(),
        turns: [],
        items: [],
      };

      client.start = async () => undefined;
      client.request = async (method: string, params: unknown) => {
        requests.push({ method, params });
        if (method === "thread/start") {
          return {
            thread: {
              id: "thr_reuse_worktree",
              modelProvider: "openai",
              createdAt: 1,
              updatedAt: 1,
            },
          };
        }
        if (method === "turn/start") {
          return {
            turn: {
              id: "turn_reuse_worktree",
              status: "in_progress",
              items: [],
            },
          };
        }
        return {};
      };

      service.readThreadAfterStart = async () => expectedDetail;

      try {
        const detail = await service.startThreadForCard({
          projectId: "codex",
          cardId: card.id,
          prompt: "Reuse this worktree",
          threadName: "Thread",
        });
        expect(detail).toBe(expectedDetail);
        expect((requests[0]?.params as { cwd?: string })?.cwd).toBe(managedWorktreePath);
        expect((requests[1]?.params as { cwd?: string })?.cwd).toBe(managedWorktreePath);
      } finally {
        await service.shutdown();
        fs.rmSync(managedWorktreePath, { recursive: true, force: true });
      }
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("recreates and persists managed worktree path when the stored path is missing", async () => {
    const ran = await withTempDatabase(async () => {
      const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-worktree-repo-"));
      initializeGitRepository(repoPath);
      createProject({ id: "worktree-project", name: "Worktree Project", workspacePath: repoPath });
      const missingWorktreePath = path.join(repoPath, "missing-worktree-path");
      const card = await createCard("worktree-project", "in_progress", {
        title: "Recreate missing managed worktree",
        runInTarget: "newWorktree",
        runInWorktreePath: missingWorktreePath,
      });

      const service = createService();
      const client = Reflect.get(service as object, "client") as {
        start: () => Promise<void>;
        request: (method: string, params: unknown) => Promise<unknown>;
      };
      const requests: Array<{ method: string; params: unknown }> = [];
      let threadCount = 0;

      client.start = async () => undefined;
      client.request = async (method: string, params: unknown) => {
        requests.push({ method, params });
        if (method === "thread/start") {
          threadCount += 1;
          return {
            thread: {
              id: `thr_recreate_worktree_${threadCount}`,
              modelProvider: "openai",
              createdAt: 1,
              updatedAt: 1,
            },
          };
        }
        if (method === "turn/start") {
          return {
            turn: {
              id: `turn_recreate_worktree_${threadCount}`,
              status: "in_progress",
              items: [],
            },
          };
        }
        return {};
      };

      service.readThreadAfterStart = async (threadId: string) => {
        const link = getCodexCardThreadLink(threadId);
        return {
          threadId,
          projectId: "worktree-project",
          cardId: card.id,
          threadName: "Thread",
          threadPreview: "",
          modelProvider: "openai",
          cwd: link?.cwd ?? "",
          statusType: "active",
          statusActiveFlags: [],
          archived: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          linkedAt: new Date().toISOString(),
          turns: [],
          items: [],
        };
      };

      try {
        await service.startThreadForCard({
          projectId: "worktree-project",
          cardId: card.id,
          prompt: "First start should recreate",
          threadName: "Thread",
        });
        await service.startThreadForCard({
          projectId: "worktree-project",
          cardId: card.id,
          prompt: "Second start should reuse",
          threadName: "Thread",
        });

        const firstThreadCwd = (requests[0]?.params as { cwd?: string })?.cwd ?? "";
        const firstTurnCwd = (requests[1]?.params as { cwd?: string })?.cwd ?? "";
        const secondThreadCwd = (requests[2]?.params as { cwd?: string })?.cwd ?? "";
        const secondTurnCwd = (requests[3]?.params as { cwd?: string })?.cwd ?? "";

        expect(firstThreadCwd.length > 0).toBeTrue();
        expect(firstThreadCwd === missingWorktreePath).toBeFalse();
        expect(firstTurnCwd).toBe(firstThreadCwd);
        expect(secondThreadCwd).toBe(firstThreadCwd);
        expect(secondTurnCwd).toBe(firstThreadCwd);
        expect(fs.existsSync(firstThreadCwd)).toBeTrue();

        const updated = await getCard("worktree-project", card.id);
        expect(updated?.runInWorktreePath).toBe(firstThreadCwd);
      } finally {
        await service.shutdown();
        fs.rmSync(repoPath, { recursive: true, force: true });
      }
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("runs selected environment setup script before starting thread in a new worktree", async () => {
    const ran = await withTempDatabase(async () => {
      const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-env-setup-success-repo-"));
      initializeGitRepository(repoPath);
      createProject({ id: "env-setup-project", name: "Env Setup", workspacePath: repoPath });
      const environmentsDir = path.join(repoPath, ".codex", "environments");
      fs.mkdirSync(environmentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(environmentsDir, "environment.toml"),
        [
          'name = "setup-success"',
          "",
          "[setup]",
          'script = "echo setup-ok > .setup-success.txt"',
          "",
        ].join("\n"),
        "utf8",
      );

      const card = await createCard("env-setup-project", "in_progress", {
        title: "Run environment setup",
        runInTarget: "newWorktree",
        runInEnvironmentPath: ".codex/environments/environment.toml",
      });

      const service = createService();
      const client = Reflect.get(service as object, "client") as {
        start: () => Promise<void>;
        request: (method: string, params: unknown) => Promise<unknown>;
      };
      const requests: Array<{ method: string; params: unknown }> = [];
      const events: CodexEvent[] = [];

      (service as unknown as {
        on: (eventName: "event", listener: (event: CodexEvent) => void) => void;
      }).on("event", (event) => {
        events.push(event);
      });

      client.start = async () => undefined;
      client.request = async (method: string, params: unknown) => {
        requests.push({ method, params });
        if (method === "thread/start") {
          return {
            thread: {
              id: "thr_env_setup_success",
              modelProvider: "openai",
              createdAt: 1,
              updatedAt: 1,
            },
          };
        }
        if (method === "turn/start") {
          return {
            turn: {
              id: "turn_env_setup_success",
              status: "in_progress",
              items: [],
            },
          };
        }
        return {};
      };

      service.readThreadAfterStart = async (threadId: string) => {
        const link = getCodexCardThreadLink(threadId);
        return {
          threadId,
          projectId: "env-setup-project",
          cardId: card.id,
          threadName: "Thread",
          threadPreview: "",
          modelProvider: "openai",
          cwd: link?.cwd ?? "",
          statusType: "active",
          statusActiveFlags: [],
          archived: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          linkedAt: new Date().toISOString(),
          turns: [],
          items: [],
        };
      };

      try {
        await service.startThreadForCard({
          projectId: "env-setup-project",
          cardId: card.id,
          prompt: "Run setup then start",
          threadName: "Thread",
        });

        const createdWorktreePath = (requests[0]?.params as { cwd?: string })?.cwd ?? "";
        expect(createdWorktreePath.length > 0).toBeTrue();
        expect(fs.existsSync(path.join(createdWorktreePath, ".setup-success.txt"))).toBeTrue();

        const updated = await getCard("env-setup-project", card.id);
        expect(updated?.runInWorktreePath).toBe(createdWorktreePath);

        const progressEvents = events.filter(
          (event): event is Extract<CodexEvent, { type: "threadStartProgress" }> => event.type === "threadStartProgress",
        );
        expect(progressEvents.length > 0).toBeTrue();
        expect(progressEvents.some((event) => event.phase === "creatingWorktree")).toBeTrue();
        expect(progressEvents.some((event) => event.phase === "runningSetup")).toBeTrue();
        expect(progressEvents.some((event) => event.phase === "startingThread")).toBeTrue();
        expect(progressEvents.some((event) => event.phase === "ready")).toBeTrue();

        const mergedOutput = progressEvents.map((event) => event.outputDelta ?? "").join("");
        expect(mergedOutput.includes("Starting worktree creation")).toBeTrue();
        expect(mergedOutput.includes("Running setup script .codex/environments/environment.toml")).toBeTrue();
        expect(mergedOutput.includes("Setup script completed")).toBeTrue();
      } finally {
        await service.shutdown();
        fs.rmSync(repoPath, { recursive: true, force: true });
      }
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("supports setup script output above 1MB without failing thread startup", async () => {
    const ran = await withTempDatabase(async () => {
      const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-env-setup-large-output-repo-"));
      initializeGitRepository(repoPath);
      createProject({ id: "env-large-output-project", name: "Env Setup Large Output", workspacePath: repoPath });
      const environmentsDir = path.join(repoPath, ".codex", "environments");
      fs.mkdirSync(environmentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(environmentsDir, "environment.toml"),
        [
          'name = "setup-large-output"',
          "",
          "[setup]",
          "script = '''",
          "i=0",
          "while [ $i -lt 120000 ]; do",
          "  printf '%s\\n' 'setup-output-line'",
          "  i=$((i+1))",
          "done",
          "echo setup-ok > .setup-large-output.txt",
          "'''",
          "",
        ].join("\n"),
        "utf8",
      );

      const card = await createCard("env-large-output-project", "in_progress", {
        title: "Run environment setup with large output",
        runInTarget: "newWorktree",
        runInEnvironmentPath: ".codex/environments/environment.toml",
      });

      const service = createService();
      const client = Reflect.get(service as object, "client") as {
        start: () => Promise<void>;
        request: (method: string, params: unknown) => Promise<unknown>;
      };
      const requests: Array<{ method: string; params: unknown }> = [];

      client.start = async () => undefined;
      client.request = async (method: string, params: unknown) => {
        requests.push({ method, params });
        if (method === "thread/start") {
          return {
            thread: {
              id: "thr_env_setup_large_output",
              modelProvider: "openai",
              createdAt: 1,
              updatedAt: 1,
            },
          };
        }
        if (method === "turn/start") {
          return {
            turn: {
              id: "turn_env_setup_large_output",
              status: "in_progress",
              items: [],
            },
          };
        }
        return {};
      };

      service.readThreadAfterStart = async (threadId: string) => {
        const link = getCodexCardThreadLink(threadId);
        return {
          threadId,
          projectId: "env-large-output-project",
          cardId: card.id,
          threadName: "Thread",
          threadPreview: "",
          modelProvider: "openai",
          cwd: link?.cwd ?? "",
          statusType: "active",
          statusActiveFlags: [],
          archived: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          linkedAt: new Date().toISOString(),
          turns: [],
          items: [],
        };
      };

      try {
        await service.startThreadForCard({
          projectId: "env-large-output-project",
          cardId: card.id,
          prompt: "Run setup with large output then start",
          threadName: "Thread",
        });

        const createdWorktreePath = (requests[0]?.params as { cwd?: string })?.cwd ?? "";
        expect(createdWorktreePath.length > 0).toBeTrue();
        expect(fs.existsSync(path.join(createdWorktreePath, ".setup-large-output.txt"))).toBeTrue();
      } finally {
        await service.shutdown();
        fs.rmSync(repoPath, { recursive: true, force: true });
      }
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("aborts thread start and leaves runInWorktreePath unset when environment setup fails", async () => {
    const ran = await withTempDatabase(async () => {
      const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-env-setup-fail-repo-"));
      initializeGitRepository(repoPath);
      createProject({ id: "env-setup-fail-project", name: "Env Setup Fail", workspacePath: repoPath });
      const environmentsDir = path.join(repoPath, ".codex", "environments");
      fs.mkdirSync(environmentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(environmentsDir, "environment.toml"),
        [
          'name = "setup-fail"',
          "",
          "[setup]",
          "script = '''",
          "echo setup-fail",
          "exit 7",
          "'''",
          "",
        ].join("\n"),
        "utf8",
      );

      const card = await createCard("env-setup-fail-project", "in_progress", {
        title: "Failing setup",
        runInTarget: "newWorktree",
        runInEnvironmentPath: ".codex/environments/environment.toml",
      });

      const service = createService();
      const client = Reflect.get(service as object, "client") as {
        start: () => Promise<void>;
        request: (method: string, params: unknown) => Promise<unknown>;
      };
      const requests: Array<{ method: string; params: unknown }> = [];
      const events: CodexEvent[] = [];

      (service as unknown as {
        on: (eventName: "event", listener: (event: CodexEvent) => void) => void;
      }).on("event", (event) => {
        events.push(event);
      });

      client.start = async () => undefined;
      client.request = async (method: string, params: unknown) => {
        requests.push({ method, params });
        return {};
      };

      try {
        let failed = false;
        let message = "";
        try {
          await service.startThreadForCard({
            projectId: "env-setup-fail-project",
            cardId: card.id,
            prompt: "This should fail before thread/start",
          });
        } catch (error) {
          failed = true;
          message = error instanceof Error ? error.message : String(error);
        }

        expect(failed).toBeTrue();
        expect(message.includes("Failed to set up new worktree using environment")).toBeTrue();
        expect(message.includes("setup-fail")).toBeTrue();
        expect(requests.length).toBe(0);

        const updated = await getCard("env-setup-fail-project", card.id);
        expect(updated?.runInWorktreePath).toBe(undefined);

        const progressEvents = events.filter(
          (event): event is Extract<CodexEvent, { type: "threadStartProgress" }> => event.type === "threadStartProgress",
        );
        expect(progressEvents.some((event) => event.phase === "failed")).toBeTrue();
      } finally {
        await service.shutdown();
        fs.rmSync(repoPath, { recursive: true, force: true });
      }
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("removes the created worktree when the card disappears before persisting its path", async () => {
    const ran = await withTempDatabase(async () => {
      const kanbanDir = process.env.KANBAN_DIR;
      if (!kanbanDir) {
        throw new Error("KANBAN_DIR was not set by withTempDatabase");
      }

      const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-persist-fail-repo-"));
      initializeGitRepository(repoPath);
      createProject({ id: "persist-fail-project", name: "Persist Fail", workspacePath: repoPath });

      const environmentsDir = path.join(repoPath, ".codex", "environments");
      fs.mkdirSync(environmentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(environmentsDir, "environment.toml"),
        [
          'name = "slow-setup"',
          "",
          "[setup]",
          "script = '''",
          "sleep 0.5",
          "'''",
          "",
        ].join("\n"),
        "utf8",
      );

      const card = await createCard("persist-fail-project", "in_progress", {
        title: "Persist missing card",
        runInTarget: "newWorktree",
        runInEnvironmentPath: ".codex/environments/environment.toml",
      });

      const service = createService();
      const client = Reflect.get(service as object, "client") as {
        start: () => Promise<void>;
        request: (method: string, params: unknown) => Promise<unknown>;
      };
      const requests: Array<{ method: string; params: unknown }> = [];
      let resolveRunningSetup: (() => void) | null = null;
      const runningSetupSeen = new Promise<void>((resolve) => {
        resolveRunningSetup = resolve;
      });

      (service as unknown as {
        on: (eventName: "event", listener: (event: CodexEvent) => void) => void;
      }).on("event", (event) => {
        if (event.type === "threadStartProgress" && event.phase === "runningSetup") {
          resolveRunningSetup?.();
          resolveRunningSetup = null;
        }
      });

      client.start = async () => undefined;
      client.request = async (method: string, params: unknown) => {
        requests.push({ method, params });
        return {};
      };

      try {
        const startPromise = service.startThreadForCard({
          projectId: "persist-fail-project",
          cardId: card.id,
          prompt: "This should fail before thread/start",
        });

        await runningSetupSeen;
        await deleteCard("persist-fail-project", "in_progress", card.id);

        let failed = false;
        let message = "";
        try {
          await startPromise;
        } catch (error) {
          failed = true;
          message = error instanceof Error ? error.message : String(error);
        }

        expect(failed).toBeTrue();
        expect(message.includes("no longer exists while persisting managed worktree path")).toBeTrue();
        expect(requests.length).toBe(0);
        expect(await getCard("persist-fail-project", card.id)).toBe(null);

        const worktreesRoot = path.join(kanbanDir, "worktrees");
        const managedEntries = fs.existsSync(worktreesRoot) ? fs.readdirSync(worktreesRoot) : [];
        expect(managedEntries.length).toBe(0);
      } finally {
        await service.shutdown();
        fs.rmSync(repoPath, { recursive: true, force: true });
      }
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("does not rerun environment setup when reusing persisted managed worktree path", async () => {
    const ran = await withTempDatabase(async () => {
      const kanbanDir = process.env.KANBAN_DIR;
      if (!kanbanDir) {
        throw new Error("KANBAN_DIR was not set by withTempDatabase");
      }

      const managedWorktreePath = path.join(kanbanDir, "worktrees", "reuse-env", "codex");
      fs.mkdirSync(managedWorktreePath, { recursive: true });

      const card = await createCard("codex", "in_progress", {
        title: "Reuse persisted worktree with env",
        runInTarget: "newWorktree",
        runInWorktreePath: managedWorktreePath,
        runInEnvironmentPath: ".codex/environments/missing.toml",
      });

      const service = createService();
      const client = Reflect.get(service as object, "client") as {
        start: () => Promise<void>;
        request: (method: string, params: unknown) => Promise<unknown>;
      };
      const requests: Array<{ method: string; params: unknown }> = [];

      client.start = async () => undefined;
      client.request = async (method: string, params: unknown) => {
        requests.push({ method, params });
        if (method === "thread/start") {
          return {
            thread: {
              id: "thr_reuse_env_setup",
              modelProvider: "openai",
              createdAt: 1,
              updatedAt: 1,
            },
          };
        }
        if (method === "turn/start") {
          return {
            turn: {
              id: "turn_reuse_env_setup",
              status: "in_progress",
              items: [],
            },
          };
        }
        return {};
      };

      service.readThreadAfterStart = async () => ({
        threadId: "thr_reuse_env_setup",
        projectId: "codex",
        cardId: card.id,
        threadName: "Thread",
        threadPreview: "",
        modelProvider: "openai",
        cwd: managedWorktreePath,
        statusType: "active",
        statusActiveFlags: [],
        archived: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        linkedAt: new Date().toISOString(),
        turns: [],
        items: [],
      });

      try {
        await service.startThreadForCard({
          projectId: "codex",
          cardId: card.id,
          prompt: "Reuse existing path",
          threadName: "Thread",
        });

        expect((requests[0]?.params as { cwd?: string })?.cwd).toBe(managedWorktreePath);
        expect(fs.existsSync(path.join(managedWorktreePath, ".should-not-run"))).toBeFalse();
      } finally {
        await service.shutdown();
      }
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("lists managed worktrees once per path when reused by multiple threads", async () => {
    const ran = await withTempDatabase(async () => {
      const card = await createCard("codex", "in_progress", {
        title: "Managed worktree dedupe",
        runInTarget: "newWorktree",
      });
      const kanbanDir = process.env.KANBAN_DIR;
      if (!kanbanDir) {
        throw new Error("KANBAN_DIR was not set by withTempDatabase");
      }
      const sharedPath = path.join(kanbanDir, "worktrees", "reuse", "codex");
      fs.mkdirSync(sharedPath, { recursive: true });

      const olderLinkedAt = "2026-03-01T00:00:00.000Z";
      const newerLinkedAt = "2026-03-02T00:00:00.000Z";
      upsertCodexCardThreadLink({
        projectId: "codex",
        cardId: card.id,
        threadId: "thr_reused_path_old",
        threadName: "Old Thread",
        cwd: sharedPath,
        linkedAt: olderLinkedAt,
      });
      upsertCodexCardThreadLink({
        projectId: "codex",
        cardId: card.id,
        threadId: "thr_reused_path_new",
        threadName: "New Thread",
        cwd: sharedPath,
        linkedAt: newerLinkedAt,
      });

      const service = createService();
      try {
        const records = await service.listManagedWorktrees();
        expect(records.length).toBe(1);
        expect(records[0]?.path).toBe(path.resolve(sharedPath));
        expect(records[0]?.threadId).toBe("thr_reused_path_new");
        expect(records[0]?.linkedAt).toBe(newerLinkedAt);
      } finally {
        await service.shutdown();
      }
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("deletes managed worktree directory and unlinks all threads that point to that path", async () => {
    const ran = await withTempDatabase(async () => {
      const card = await createCard("codex", "in_progress", {
        title: "Managed worktree delete",
        runInTarget: "newWorktree",
      });
      const kanbanDir = process.env.KANBAN_DIR;
      if (!kanbanDir) {
        throw new Error("KANBAN_DIR was not set by withTempDatabase");
      }

      const sharedPath = path.join(kanbanDir, "worktrees", "delete", "codex");
      const otherPath = path.join(kanbanDir, "worktrees", "keep", "codex");
      fs.mkdirSync(sharedPath, { recursive: true });
      fs.mkdirSync(otherPath, { recursive: true });

      upsertCodexCardThreadLink({
        projectId: "codex",
        cardId: card.id,
        threadId: "thr_delete_old",
        cwd: sharedPath,
        linkedAt: "2026-03-01T00:00:00.000Z",
      });
      upsertCodexCardThreadLink({
        projectId: "codex",
        cardId: card.id,
        threadId: "thr_delete_new",
        cwd: sharedPath,
        linkedAt: "2026-03-02T00:00:00.000Z",
      });
      upsertCodexCardThreadLink({
        projectId: "codex",
        cardId: card.id,
        threadId: "thr_keep",
        cwd: otherPath,
        linkedAt: "2026-03-03T00:00:00.000Z",
      });

      const service = createService();
      try {
        const deleted = await service.deleteManagedWorktree("thr_delete_new");
        expect(deleted).toBeTrue();
        expect(fs.existsSync(sharedPath)).toBeFalse();
        expect(getCodexCardThreadLink("thr_delete_new")).toBe(null);
        expect(getCodexCardThreadLink("thr_delete_old")).toBe(null);
        expect(getCodexCardThreadLink("thr_keep")).not.toBeNull();
      } finally {
        await service.shutdown();
      }
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("removes git worktree metadata when deleting a managed worktree", async () => {
    const ran = await withTempDatabase(async () => {
      const card = await createCard("codex", "in_progress", {
        title: "Managed git worktree remove",
        runInTarget: "newWorktree",
      });
      const kanbanDir = process.env.KANBAN_DIR;
      if (!kanbanDir) {
        throw new Error("KANBAN_DIR was not set by withTempDatabase");
      }

      const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-delete-worktree-repo-"));
      initializeGitRepository(repositoryPath);

      const managedPath = path.join(kanbanDir, "worktrees", "git-remove", "codex");
      fs.mkdirSync(path.dirname(managedPath), { recursive: true });
      execFileSync("git", ["worktree", "add", "--detach", managedPath, "main"], { cwd: repositoryPath });

      upsertCodexCardThreadLink({
        projectId: "codex",
        cardId: card.id,
        threadId: "thr_git_remove",
        cwd: managedPath,
      });

      const service = createService();
      try {
        const deleted = await service.deleteManagedWorktree("thr_git_remove");
        expect(deleted).toBeTrue();
        expect(fs.existsSync(managedPath)).toBeFalse();

        const worktreeListOutput = execFileSync(
          "git",
          ["worktree", "list", "--porcelain"],
          { cwd: repositoryPath, encoding: "utf8" },
        );
        expect(worktreeListOutput.includes(path.resolve(managedPath))).toBeFalse();
      } finally {
        await service.shutdown();
        fs.rmSync(repositoryPath, { recursive: true, force: true });
      }
    });

    if (!ran) expect(true).toBeTrue();
  });

  test("blocks cloud run target before thread creation", async () => {
    const ran = await withTempDatabase(async () => {
      const card = await createCard("codex", "in_progress", {
        title: "Cloud run target",
        runInTarget: "cloud",
      });
      const service = createService();
      const client = Reflect.get(service as object, "client") as {
        start: () => Promise<void>;
        request: (method: string, params: unknown) => Promise<unknown>;
      };

      client.start = async () => undefined;
      client.request = async () => {
        throw new Error("client.request should not be called for cloud run target");
      };

      try {
        let failed = false;
        let message = "";
        try {
          await service.startThreadForCard({
            projectId: "codex",
            cardId: card.id,
            prompt: "Try cloud",
          });
        } catch (error) {
          failed = true;
          message = error instanceof Error ? error.message : String(error);
        }
        expect(failed).toBeTrue();
        expect(message.includes("Cloud run target is not available yet")).toBeTrue();
      } finally {
        await service.shutdown();
      }
    });

    if (!ran) expect(true).toBeTrue();
  });
});

describe("codex-service approval fallback", () => {
  test("auto-accepts approval requests in full-access mode", async () => {
    const service = createService();
    const serviceInternals = service as unknown as {
      parseThreadRef: (threadId: string) => { projectId: string; cardId: string; cwd: string | null } | null;
      handleServerRequest: (request: { id: string | number; method: string; params: unknown }) => Promise<unknown>;
    };

    serviceInternals.parseThreadRef = () => ({ projectId: "codex", cardId: "card-1", cwd: null });
    service.setProjectPermissionMode("codex", "full-access");

    try {
      const result = await serviceInternals.handleServerRequest({
        id: "req_full_access",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thr_full",
          turnId: "turn_full",
          itemId: "item_full",
          reason: "Needs permissions",
        },
      });

      expect(JSON.stringify(result)).toBe(JSON.stringify({ decision: "accept" }));
    } finally {
      await service.shutdown();
    }
  });

  test("queues approval requests outside full-access mode", async () => {
    const service = createService();
    const serviceInternals = service as unknown as {
      parseThreadRef: (threadId: string) => { projectId: string; cardId: string; cwd: string | null } | null;
      handleServerRequest: (request: { id: string | number; method: string; params: unknown }) => Promise<unknown>;
      pendingApprovals: Map<
        string,
        {
          reject: (reason?: unknown) => void;
        }
      >;
    };

    serviceInternals.parseThreadRef = () => ({ projectId: "codex", cardId: "card-1", cwd: null });
    service.setProjectPermissionMode("codex", "sandbox");

    try {
      const requestPromise = serviceInternals.handleServerRequest({
        id: "req_sandbox",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thr_default",
          turnId: "turn_default",
          itemId: "item_default",
          reason: "Needs permissions",
        },
      });

      await Promise.resolve();
      expect(serviceInternals.pendingApprovals.size).toBe(1);

      for (const pending of serviceInternals.pendingApprovals.values()) {
        pending.reject(new Error("test cleanup"));
      }
      await requestPromise.catch(() => undefined);
    } finally {
      await service.shutdown();
    }
  });

  test("keys pending approvals by JSON-RPC request.id", async () => {
    const service = createService();
    const serviceInternals = service as unknown as {
      parseThreadRef: (threadId: string) => { projectId: string; cardId: string; cwd: string | null } | null;
      handleServerRequest: (request: { id: string | number; method: string; params: unknown }) => Promise<unknown>;
      pendingApprovals: Map<
        string,
        {
          request: { requestId: string };
          reject: (reason?: unknown) => void;
        }
      >;
      on: (eventName: "event", listener: (event: CodexEvent) => void) => void;
    };
    const events: CodexEvent[] = [];

    serviceInternals.parseThreadRef = () => ({ projectId: "codex", cardId: "card-1", cwd: null });
    service.setProjectPermissionMode("codex", "sandbox");
    serviceInternals.on("event", (event) => {
      events.push(event);
    });

    try {
      const requestPromise = serviceInternals.handleServerRequest({
        id: 42,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thr_request_id",
          turnId: "turn_request_id",
          itemId: "item_request_id",
          reason: "Needs permissions",
        },
      });

      await Promise.resolve();
      expect(serviceInternals.pendingApprovals.has("42")).toBeTrue();

      const requestedEvent = events.find(
        (event): event is Extract<CodexEvent, { type: "approvalRequested" }> => event.type === "approvalRequested",
      );
      expect(requestedEvent?.request.requestId).toBe("42");

      for (const pending of serviceInternals.pendingApprovals.values()) {
        pending.reject(new Error("test cleanup"));
      }
      await requestPromise.catch(() => undefined);
    } finally {
      await service.shutdown();
    }
  });
});

describe("codex-service streaming notification parity", () => {
  test("builds plan items incrementally from item/plan/delta", async () => {
    const service = createService();
    const serviceInternals = service as unknown as {
      handleNotification: (method: string, params: unknown) => Promise<void>;
      persistThreadSnapshot: (threadId: string) => void;
      on: (eventName: "event", listener: (event: CodexEvent) => void) => void;
    };
    const events: CodexEvent[] = [];

    serviceInternals.persistThreadSnapshot = () => {};
    serviceInternals.on("event", (event) => {
      events.push(event);
    });

    try {
      await serviceInternals.handleNotification("item/plan/delta", {
        threadId: "thr_plan_delta",
        turnId: "turn_plan_delta",
        itemId: "plan_item",
        delta: "1. Clarify requirements",
      });
      await serviceInternals.handleNotification("item/plan/delta", {
        threadId: "thr_plan_delta",
        turnId: "turn_plan_delta",
        itemId: "plan_item",
        delta: "\n2. Implement changes",
      });

      const upserts = events.filter(
        (event): event is Extract<CodexEvent, { type: "itemUpsert" }> => event.type === "itemUpsert",
      );
      const deltas = events.filter(
        (event): event is Extract<CodexEvent, { type: "itemDelta" }> => event.type === "itemDelta",
      );
      const lastUpsert = upserts[upserts.length - 1];

      expect(deltas.length).toBe(2);
      expect(lastUpsert?.item.type).toBe("plan");
      expect(lastUpsert?.item.normalizedKind).toBe("plan");
      expect(lastUpsert?.item.markdownText).toBe("1. Clarify requirements\n2. Implement changes");
    } finally {
      await service.shutdown();
    }
  });

  test("handles serverRequest/resolved by clearing pending approvals and user inputs", async () => {
    const service = createService();
    const serviceInternals = service as unknown as {
      parseThreadRef: (threadId: string) => { projectId: string; cardId: string; cwd: string | null } | null;
      handleServerRequest: (request: { id: string | number; method: string; params: unknown }) => Promise<unknown>;
      handleNotification: (method: string, params: unknown) => Promise<void>;
      pendingApprovals: Map<string, unknown>;
      pendingUserInputs: Map<string, unknown>;
      on: (eventName: "event", listener: (event: CodexEvent) => void) => void;
    };
    const events: CodexEvent[] = [];

    serviceInternals.parseThreadRef = () => ({ projectId: "codex", cardId: "card-1", cwd: null });
    service.setProjectPermissionMode("codex", "sandbox");
    serviceInternals.on("event", (event) => {
      events.push(event);
    });

    try {
      const approvalPromise = serviceInternals.handleServerRequest({
        id: "approval_req",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thr_resolved",
          turnId: "turn_resolved",
          itemId: "item_approval",
        },
      });
      const userInputPromise = serviceInternals.handleServerRequest({
        id: "input_req",
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thr_resolved",
          turnId: "turn_resolved",
          itemId: "item_input",
          questions: [
            {
              id: "q1",
              header: "Header",
              question: "Question",
            },
          ],
        },
      });

      await Promise.resolve();
      expect(serviceInternals.pendingApprovals.has("approval_req")).toBeTrue();
      expect(serviceInternals.pendingUserInputs.has("input_req")).toBeTrue();

      await serviceInternals.handleNotification("serverRequest/resolved", {
        threadId: "thr_resolved",
        requestId: "approval_req",
      });
      await serviceInternals.handleNotification("serverRequest/resolved", {
        threadId: "thr_resolved",
        requestId: "input_req",
      });

      const approvalResult = await approvalPromise;
      const inputResult = await userInputPromise;
      expect(JSON.stringify(approvalResult)).toBe(JSON.stringify({ decision: "cancel" }));
      expect(JSON.stringify(inputResult)).toBe(JSON.stringify({ answers: {} }));
      expect(serviceInternals.pendingApprovals.has("approval_req")).toBeFalse();
      expect(serviceInternals.pendingUserInputs.has("input_req")).toBeFalse();

      const approvalResolvedEvents = events.filter(
        (event): event is Extract<CodexEvent, { type: "approvalResolved" }> => event.type === "approvalResolved",
      );
      const userInputResolvedEvents = events.filter(
        (event): event is Extract<CodexEvent, { type: "userInputResolved" }> => event.type === "userInputResolved",
      );
      expect(approvalResolvedEvents.some((event) => event.requestId === "approval_req")).toBeTrue();
      expect(userInputResolvedEvents.some((event) => event.requestId === "input_req")).toBeTrue();
    } finally {
      await service.shutdown();
    }
  });

  test("respondToUserInput persists answered questions onto the transcript item", async () => {
    const service = createService();
    const serviceInternals = service as unknown as {
      parseThreadRef: (threadId: string) => { projectId: string; cardId: string; cwd: string | null } | null;
      handleServerRequest: (request: { id: string | number; method: string; params: unknown }) => Promise<unknown>;
      persistThreadSnapshot: (threadId: string) => void;
      on: (eventName: "event", listener: (event: CodexEvent) => void) => void;
    };
    const events: CodexEvent[] = [];
    const persistedThreadIds: string[] = [];

    serviceInternals.parseThreadRef = () => ({ projectId: "codex", cardId: "card-1", cwd: null });
    serviceInternals.persistThreadSnapshot = (threadId: string) => {
      persistedThreadIds.push(threadId);
    };
    serviceInternals.on("event", (event) => {
      events.push(event);
    });

    try {
      const requestPromise = serviceInternals.handleServerRequest({
        id: "input_req",
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thr_input",
          turnId: "turn_input",
          itemId: "item_input",
          questions: [
            {
              id: "q1",
              header: "Math",
              question: "What is 1 + 1?",
              options: [{ label: "2", description: "Correct" }],
            },
          ],
        },
      });

      await Promise.resolve();
      const responded = await service.respondToUserInput("input_req", { q1: ["2"] });
      expect(responded).toBeTrue();

      const resolved = await requestPromise;
      expect(JSON.stringify(resolved)).toBe(JSON.stringify({
        answers: {
          q1: {
            answers: ["2"],
          },
        },
      }));

      const itemUpserts = events.filter(
        (event): event is Extract<CodexEvent, { type: "itemUpsert" }> => event.type === "itemUpsert",
      );
      const answeredItem = itemUpserts[itemUpserts.length - 1]?.item;

      expect(answeredItem?.normalizedKind).toBe("userInputRequest");
      expect(answeredItem?.status).toBe("completed");
      expect(answeredItem?.userInputQuestions?.[0]?.question).toBe("What is 1 + 1?");
      expect(answeredItem?.userInputAnswers?.q1?.[0]).toBe("2");
      expect((answeredItem?.rawItem as { answers?: Record<string, string[]> } | undefined)?.answers?.q1?.[0]).toBe("2");
      expect(persistedThreadIds.includes("thr_input")).toBeTrue();
    } finally {
      await service.shutdown();
    }
  });
});

describe("codex-service custom permission descriptions", () => {
  test("reports parsed CODEX_HOME config values for custom mode", async () => {
    const service = createService();
    const serviceInternals = service as unknown as {
      findProjectCodexConfig: (projectId: string) => { configPath: string; displayPath: string } | null;
    };
    const originalCodexHome = process.env.CODEX_HOME;
    const tempCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-codex-home-"));
    const configPath = path.join(tempCodexHome, "config.toml");

    fs.writeFileSync(
      configPath,
      [
        'sandbox_mode = "workspace-write"',
        'approval_policy = "on-request"',
        "",
      ].join("\n"),
      "utf8",
    );
    process.env.CODEX_HOME = tempCodexHome;
    serviceInternals.findProjectCodexConfig = () => null;

    try {
      const description = service.getCustomPermissionModeDescription("codex");
      expect(description).toBe(
        "User config ($CODEX_HOME/config.toml): sandbox_mode=workspace-write; approval_policy=on-request.",
      );
    } finally {
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
      fs.rmSync(tempCodexHome, { recursive: true, force: true });
      await service.shutdown();
    }
  });

  test("reports parsed workspace config values for custom mode", async () => {
    const service = createService();
    const ran = await withTempDatabase(async () => {
      const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-codex-workspace-config-"));
      const projectId = "codex-workspace-config";

      createProject({ id: projectId, name: "Workspace Config", workspacePath });
      fs.writeFileSync(
        path.join(workspacePath, "config.toml"),
        [
          'sandbox_mode = "workspace-write"',
          'approval_policy = "on-request"',
          "",
        ].join("\n"),
        "utf8",
      );

      try {
        const description = service.getCustomPermissionModeDescription(projectId);
        expect(description).toBe(
          "Project config (config.toml): sandbox_mode=workspace-write; approval_policy=on-request.",
        );
      } finally {
        fs.rmSync(workspacePath, { recursive: true, force: true });
      }
    });

    try {
      if (!ran) expect(true).toBeTrue();
    } finally {
      await service.shutdown();
    }
  });

  test("prefers user-config display path when walk-up finds ~/.codex/config.toml", async () => {
    const service = createService();
    const originalHome = process.env.HOME;
    const originalCodexHome = process.env.CODEX_HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-codex-home-walkup-"));
    const workspacePath = path.join(tempHome, "workspace", "project");
    const projectId = "codex-home-walkup";
    const userCodexDir = path.join(tempHome, ".codex");

    const ran = await withTempDatabase(async () => {
      fs.mkdirSync(workspacePath, { recursive: true });
      fs.mkdirSync(userCodexDir, { recursive: true });
      fs.writeFileSync(
        path.join(userCodexDir, "config.toml"),
        [
          'sandbox_mode = "workspace-write"',
          'approval_policy = "on-request"',
          "",
        ].join("\n"),
        "utf8",
      );
      createProject({ id: projectId, name: "Home Walkup", workspacePath });
      process.env.HOME = tempHome;
      delete process.env.CODEX_HOME;

      const description = service.getCustomPermissionModeDescription(projectId);
      expect(description).toBe(
        "User config (~/.codex/config.toml): sandbox_mode=workspace-write; approval_policy=on-request.",
      );
    });

    try {
      if (!ran) expect(true).toBeTrue();
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
      fs.rmSync(tempHome, { recursive: true, force: true });
      await service.shutdown();
    }
  });
});

describe("codex-service item identity dedupe", () => {
  test("treats synthetic and live user-message ids as the same item within a turn", async () => {
    const service = createService();
    const serviceInternals = service as unknown as {
      mergeItem: (item: CodexItemView) => void;
      itemByThreadTurn: Map<string, Map<string, CodexItemView>>;
    };

    const baseItem: Omit<CodexItemView, "itemId" | "createdAt" | "updatedAt"> = {
      threadId: "thr_dedupe",
      turnId: "turn_dedupe",
      type: "userMessage",
      normalizedKind: "userMessage",
      role: "user",
      markdownText: "say \"hi\"",
    };

    try {
      serviceInternals.mergeItem({
        ...baseItem,
        itemId: "item-16",
        createdAt: 10,
        updatedAt: 10,
      });
      serviceInternals.mergeItem({
        ...baseItem,
        itemId: "878d0f9b-7c9f-468f-b297-9063a9c350ad",
        createdAt: 20,
        updatedAt: 20,
      });

      const byItem = serviceInternals.itemByThreadTurn.get("thr_dedupe:turn_dedupe");
      expect(byItem?.size).toBe(1);
      const merged = byItem ? Array.from(byItem.values())[0] : null;
      expect(merged?.markdownText).toBe("say \"hi\"");
      expect(merged?.itemId).toBe("878d0f9b-7c9f-468f-b297-9063a9c350ad");
    } finally {
      await service.shutdown();
    }
  });

  test("treats synthetic and live assistant-message ids as the same item within a turn", async () => {
    const service = createService();
    const serviceInternals = service as unknown as {
      mergeItem: (item: CodexItemView) => void;
      itemByThreadTurn: Map<string, Map<string, CodexItemView>>;
    };

    const baseItem: Omit<CodexItemView, "itemId" | "createdAt" | "updatedAt"> = {
      threadId: "thr_dedupe_assistant",
      turnId: "turn_dedupe_assistant",
      type: "agentMessage",
      normalizedKind: "assistantMessage",
      role: "assistant",
      markdownText: "I added the shared module. Next I’m rewiring project-switcher.tsx.",
    };

    try {
      serviceInternals.mergeItem({
        ...baseItem,
        itemId: "item-15",
        createdAt: 10,
        updatedAt: 10,
      });
      serviceInternals.mergeItem({
        ...baseItem,
        itemId: "msg_0827a35f777c91c901699cc22e743081918e86cc129ba14c30",
        createdAt: 20,
        updatedAt: 20,
      });

      const byItem = serviceInternals.itemByThreadTurn.get("thr_dedupe_assistant:turn_dedupe_assistant");
      expect(byItem?.size).toBe(1);
      const merged = byItem ? Array.from(byItem.values())[0] : null;
      expect(merged?.normalizedKind).toBe("assistantMessage");
      expect(merged?.markdownText).toBe("I added the shared module. Next I’m rewiring project-switcher.tsx.");
      expect(merged?.itemId).toBe("msg_0827a35f777c91c901699cc22e743081918e86cc129ba14c30");
    } finally {
      await service.shutdown();
    }
  });

  test("does not merge two live assistant-message ids that share the same text", async () => {
    const service = createService();
    const serviceInternals = service as unknown as {
      mergeItem: (item: CodexItemView) => void;
      itemByThreadTurn: Map<string, Map<string, CodexItemView>>;
    };

    const baseItem: Omit<CodexItemView, "itemId" | "createdAt" | "updatedAt"> = {
      threadId: "thr_live_dupe_guard",
      turnId: "turn_live_dupe_guard",
      type: "agentMessage",
      normalizedKind: "assistantMessage",
      role: "assistant",
      markdownText: "Working...",
    };

    try {
      serviceInternals.mergeItem({
        ...baseItem,
        itemId: "msg_0001",
        createdAt: 10,
        updatedAt: 10,
      });
      serviceInternals.mergeItem({
        ...baseItem,
        itemId: "msg_0002",
        createdAt: 20,
        updatedAt: 20,
      });

      const byItem = serviceInternals.itemByThreadTurn.get("thr_live_dupe_guard:turn_live_dupe_guard");
      expect(byItem?.size).toBe(2);
      expect(Array.from(byItem?.values() ?? []).map((item) => item.itemId).sort().join(",")).toBe(
        "msg_0001,msg_0002",
      );
    } finally {
      await service.shutdown();
    }
  });
});

describe("codex-service item lifecycle status fallback", () => {
  test("derives reasoning item status from item lifecycle notifications", async () => {
    const service = createService();
    const serviceInternals = service as unknown as {
      handleNotification: (method: string, params: unknown) => Promise<void>;
      persistThreadSnapshot: (threadId: string) => void;
      on: (eventName: "event", listener: (event: CodexEvent) => void) => void;
    };
    const events: CodexEvent[] = [];

    serviceInternals.persistThreadSnapshot = () => {};

    serviceInternals.on("event", (event) => {
      events.push(event);
    });

    try {
      await serviceInternals.handleNotification("item/started", {
        threadId: "thr_status",
        turnId: "turn_status",
        item: {
          id: "item_reasoning",
          type: "reasoning",
          summary: ["Planning the next step"],
          content: [],
        },
      });

      await serviceInternals.handleNotification("item/completed", {
        threadId: "thr_status",
        turnId: "turn_status",
        item: {
          id: "item_reasoning",
          type: "reasoning",
          summary: ["Planning complete"],
          content: [],
        },
      });

      const upserts = events.filter(
        (event): event is Extract<CodexEvent, { type: "itemUpsert" }> => event.type === "itemUpsert",
      );

      expect(upserts.length).toBe(2);
      expect(upserts[0]?.item.status).toBe("inProgress");
      expect(upserts[1]?.item.status).toBe("completed");
    } finally {
      await service.shutdown();
    }
  });
});

describe("codex-service terminal turn reconciliation", () => {
  test("falls back turn/completed status and terminalizes lingering in-progress items", async () => {
    const service = createService();
    const serviceInternals = service as unknown as {
      handleNotification: (method: string, params: unknown) => Promise<void>;
      mergeTurn: (threadId: string, turn: CodexTurnSummary) => void;
      mergeItem: (item: CodexItemView) => void;
      syncThreadStatusFromKnownTurns: (threadId: string) => void;
      persistThreadSnapshot: (threadId: string) => void;
      on: (eventName: "event", listener: (event: CodexEvent) => void) => void;
    };
    const events: CodexEvent[] = [];

    serviceInternals.syncThreadStatusFromKnownTurns = () => {};
    serviceInternals.persistThreadSnapshot = () => {};
    serviceInternals.on("event", (event) => {
      events.push(event);
    });

    try {
      serviceInternals.mergeTurn("thr_terminal", {
        threadId: "thr_terminal",
        turnId: "turn_terminal",
        status: "inProgress",
        itemIds: ["item_reasoning"],
      });
      serviceInternals.mergeItem({
        threadId: "thr_terminal",
        turnId: "turn_terminal",
        itemId: "item_reasoning",
        type: "reasoning",
        normalizedKind: "reasoning",
        status: "inProgress",
        markdownText: "Thinking...",
        createdAt: 10,
        updatedAt: 10,
      });

      await serviceInternals.handleNotification("turn/completed", {
        threadId: "thr_terminal",
        turnId: "turn_terminal",
      });

      const turnEvents = events.filter(
        (event): event is Extract<CodexEvent, { type: "turn" }> => event.type === "turn",
      );
      const itemUpserts = events.filter(
        (event): event is Extract<CodexEvent, { type: "itemUpsert" }> => event.type === "itemUpsert",
      );

      expect(turnEvents.length).toBe(1);
      expect(turnEvents[0]?.turn.status).toBe("completed");
      expect(itemUpserts.length).toBe(1);
      expect(itemUpserts[0]?.item.status).toBe("completed");
    } finally {
      await service.shutdown();
    }
  });

  test("interruptTurn immediately marks known in-progress turn/items as interrupted", async () => {
    const service = createService();
    const serviceInternals = service as unknown as {
      mergeTurn: (threadId: string, turn: CodexTurnSummary) => void;
      mergeItem: (item: CodexItemView) => void;
      syncThreadStatusFromKnownTurns: (threadId: string) => void;
      persistThreadSnapshot: (threadId: string) => void;
      on: (eventName: "event", listener: (event: CodexEvent) => void) => void;
    };
    const client = Reflect.get(service as object, "client") as {
      start: () => Promise<void>;
      request: (method: string, params: unknown) => Promise<unknown>;
    };
    const events: CodexEvent[] = [];

    serviceInternals.syncThreadStatusFromKnownTurns = () => {};
    serviceInternals.persistThreadSnapshot = () => {};
    serviceInternals.on("event", (event) => {
      events.push(event);
    });

    client.start = async () => undefined;
    client.request = async () => ({});

    try {
      serviceInternals.mergeTurn("thr_interrupt_terminal", {
        threadId: "thr_interrupt_terminal",
        turnId: "turn_interrupt_terminal",
        status: "inProgress",
        itemIds: ["item_tool"],
      });
      serviceInternals.mergeItem({
        threadId: "thr_interrupt_terminal",
        turnId: "turn_interrupt_terminal",
        itemId: "item_tool",
        type: "commandExecution",
        normalizedKind: "commandExecution",
        status: "inProgress",
        toolCall: {
          subtype: "command",
          toolName: "bash",
          args: {
            command: "ls",
          },
        },
        createdAt: 10,
        updatedAt: 10,
      });

      const interrupted = await service.interruptTurn("thr_interrupt_terminal", "turn_interrupt_terminal");
      expect(interrupted).toBeTrue();

      const turnEvents = events.filter(
        (event): event is Extract<CodexEvent, { type: "turn" }> => event.type === "turn",
      );
      const itemUpserts = events.filter(
        (event): event is Extract<CodexEvent, { type: "itemUpsert" }> => event.type === "itemUpsert",
      );

      expect(turnEvents.some((event) => event.turn.status === "interrupted")).toBeTrue();
      expect(itemUpserts.some((event) => event.item.status === "interrupted")).toBeTrue();
    } finally {
      await service.shutdown();
    }
  });
});
