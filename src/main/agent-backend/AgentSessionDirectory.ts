import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { AgentBackendSessionChangedEvent } from "../../shared/agent-backend-api";
import type {
  AgentSessionConfigOption,
  AgentSessionModeState,
} from "../../shared/agent-conversation";
import {
  AcpBackendSessionManager,
  type AcpBackendSessionHandle,
} from "./acp/AcpBackendSessionManager";
import { ClaudeSessionManager } from "./claude/ClaudeSessionManager";
import type { AgentSessionHandle } from "./AgentSessionHandle";

export const projectAgentSessionModes = (
  modes: AcpBackendSessionHandle["modes"],
): AgentSessionModeState | null =>
  modes
    ? {
        currentModeId: modes.currentModeId,
        availableModes: modes.availableModes.map((mode) => ({
          id: mode.id,
          name: mode.name,
          description: mode.description ?? null,
        })),
      }
    : null;

export const projectAgentSessionConfigOptions = (
  options: AcpBackendSessionHandle["configOptions"],
): readonly AgentSessionConfigOption[] =>
  options.map((option): AgentSessionConfigOption => {
    const common = {
      id: option.id,
      name: option.name,
      description: option.description ?? null,
      category: option.category ?? null,
    };
    if (option.type === "boolean") {
      return { ...common, type: "boolean", currentValue: option.currentValue };
    }
    return {
      ...common,
      type: "select",
      currentValue: option.currentValue,
      options: option.options.map((candidate) =>
        "group" in candidate
          ? {
              group: candidate.group,
              name: candidate.name,
              options: candidate.options.map((entry) => ({
                value: entry.value,
                name: entry.name,
                description: entry.description ?? null,
              })),
            }
          : {
              value: candidate.value,
              name: candidate.name,
              description: candidate.description ?? null,
            },
      ),
    };
  });

interface SessionFamily {
  readonly get: (threadId: string) => Effect.Effect<AgentSessionHandle | null>;
  readonly observe: (threadId: string) => Effect.Effect<void>;
  readonly unobserve: (threadId: string) => Effect.Effect<void>;
  readonly close: (threadId: string) => Effect.Effect<void>;
  readonly changes: Stream.Stream<AgentBackendSessionChangedEvent>;
}

export interface AgentSessionDirectory extends SessionFamily {
  /** Open retains backend-specific authority; adaptation keeps one identity per scoped raw handle. */
  readonly adaptAcp: (handle: AcpBackendSessionHandle) => AgentSessionHandle;
}

/** Routes only the two native conversation families. Core admission and launch ownership stay outside. */
export const make = Effect.gen(function* () {
  const native = yield* ClaudeSessionManager;
  const acp = yield* AcpBackendSessionManager;
  const adapted = new WeakMap<AcpBackendSessionHandle, AgentSessionHandle>();
  const adaptAcp = (handle: AcpBackendSessionHandle): AgentSessionHandle => {
    const existing = adapted.get(handle);
    if (existing) return existing;
    const projected: AgentSessionHandle = {
      ...handle,
      get sessionId() {
        return handle.sessionId;
      },
      get modes() {
        return projectAgentSessionModes(handle.modes);
      },
      get configOptions() {
        return projectAgentSessionConfigOptions(handle.configOptions);
      },
      prompt: (text, options) => handle.prompt([{ type: "text", text }], options),
      setConfigOption: (id, value) =>
        handle.setConfigOption(id, value).pipe(Effect.map(projectAgentSessionConfigOptions)),
    };
    adapted.set(handle, projected);
    return projected;
  };
  const families: readonly SessionFamily[] = [
    native,
    {
      ...acp,
      get: (threadId) =>
        acp.get(threadId).pipe(Effect.map((handle) => (handle ? adaptAcp(handle) : null))),
    },
  ];
  const each = (action: "observe" | "unobserve" | "close", threadId: string) =>
    Effect.forEach(families, (family) => family[action](threadId), { discard: true });
  return {
    adaptAcp,
    get: (threadId) =>
      Effect.gen(function* () {
        for (const family of families) {
          const handle = yield* family.get(threadId);
          if (handle) return handle;
        }
        return null;
      }),
    observe: (threadId) => each("observe", threadId),
    unobserve: (threadId) => each("unobserve", threadId),
    close: (threadId) => each("close", threadId),
    changes: Stream.mergeAll(
      families.map((family) => family.changes),
      { concurrency: families.length },
    ),
  } satisfies AgentSessionDirectory;
});
