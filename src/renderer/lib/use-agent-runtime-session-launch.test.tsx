import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { PersistedAtomSnapshot } from "../../shared/ipc-api";
import { agentRuntimeProviderId } from "../../shared/agent-runtime-provider";
import {
  agentRuntimeChoiceKey,
  agentRuntimeComposerChoicesAtom,
  type AgentRuntimeComposerChoices,
} from "../features/local-conversation/agent-runtime-composer-choices";
import {
  MaitaiProvider,
  createMaitaiStore,
  disposeMaitaiStore,
  setMaitaiPersistenceTransport,
} from "./maitai";
import { agentRuntimeRuntime } from "./agent-runtime-runtime";
import { useAgentRuntimeSessionLaunch } from "./use-agent-runtime-session-launch";

type Provider = AgentRuntimeOperations["providers.read"]["output"][number];
const stores: ReturnType<typeof createMaitaiStore>[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) disposeMaitaiStore(store);
  vi.restoreAllMocks();
});

const binding = { kind: "opencode", instanceConfigId: "work" } as const;
const instanceId = agentRuntimeProviderId(binding)!;
const model = {
  slug: "chosen",
  name: "Chosen",
  isDefault: true,
  isCustom: false,
  capabilities: null,
};
const provider = {
  instanceId,
  driver: "opencode",
  enabled: true,
  installed: true,
  status: "ready",
  models: [model],
  version: "2.0.0",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-22T00:00:00.000Z",
  slashCommands: [],
  skills: [],
} satisfies Provider;

function setup(
  readSnapshot: () => Promise<PersistedAtomSnapshot>,
  providers: readonly Provider[] = [provider],
) {
  const store = createMaitaiStore();
  stores.push(store);
  setMaitaiPersistenceTransport(store, {
    readSnapshot,
    subscribe: () => () => {},
    mutate: vi.fn(),
  });
  vi.spyOn(agentRuntimeRuntime, "catalog").mockResolvedValue(providers);
  const launch = vi.spyOn(agentRuntimeRuntime, "launch").mockResolvedValue({
    sessionId: "draft",
    projectId: "project",
    threadId: "root",
  });
  const hook = renderHook(() => useAgentRuntimeSessionLaunch(), {
    wrapper: ({ children }: PropsWithChildren) => (
      <MaitaiProvider store={store}>{children}</MaitaiProvider>
    ),
  });
  return { ...hook, launch };
}

const snapshot = (choices: AgentRuntimeComposerChoices): PersistedAtomSnapshot => ({
  revision: 1,
  values: { [agentRuntimeComposerChoicesAtom.storageKey]: choices },
});

it("waits for the draft's persisted Agent choice before launching and retains its mode and options", async () => {
  let finishRead!: (value: PersistedAtomSnapshot) => void;
  const read = new Promise<PersistedAtomSnapshot>((resolve) => {
    finishRead = resolve;
  });
  const { result, launch } = setup(
    () => read,
    [{ ...provider, instanceId: "codex", driver: "codex" }, provider],
  );
  const options = [{ id: "variant", value: "high" }];
  const onSelectionResolved = vi.fn();
  await act(async () => {
    const pending = result.current({
      sessionId: "draft",
      projectId: "project",
      prompt: "Page task",
      onSelectionResolved,
    });
    await Promise.resolve();
    expect(launch).not.toHaveBeenCalled();
    finishRead(
      snapshot({
        [agentRuntimeChoiceKey.draft("draft", "project")]: {
          selection: { binding, model: "chosen", options },
          interactionMode: "plan",
        },
      }),
    );
    await pending;
  });
  expect(launch).toHaveBeenCalledWith(
    expect.objectContaining({
      modelSelection: { instanceId, model: "chosen", options },
      interactionMode: "plan",
    }),
  );
  expect(onSelectionResolved).toHaveBeenCalledWith("opencode");
});

it("reads the target Session and Project choice instead of another draft's choice", async () => {
  const { result, launch } = setup(async () =>
    snapshot({
      [agentRuntimeChoiceKey.draft("draft", "other-project")]: {
        selection: { binding: { kind: "codex" }, model: "missing" },
      },
      [agentRuntimeChoiceKey.draft("other-draft", "project")]: {
        selection: { binding: { kind: "codex" }, model: "missing" },
      },
      [agentRuntimeChoiceKey.draft("draft", "project")]: {
        selection: { binding, model: "chosen" },
      },
    }),
  );
  await act(async () => {
    await result.current({ sessionId: "draft", projectId: "project", prompt: "Scheduled reply" });
  });
  expect(launch).toHaveBeenCalledWith(
    expect.objectContaining({ modelSelection: { instanceId, model: "chosen" } }),
  );
});

it("keeps an unavailable persisted choice explicit and does not silently switch Agents", async () => {
  const { result, launch } = setup(async () =>
    snapshot({
      [agentRuntimeChoiceKey.draft("draft", "project")]: {
        selection: { binding, model: "removed" },
      },
    }),
  );
  await act(async () => {
    await expect(
      result.current({ sessionId: "draft", projectId: "project", prompt: "Task" }),
    ).rejects.toThrow(/selected Agent.*unavailable/i);
  });
  expect(launch).not.toHaveBeenCalled();
});

it("does not launch a default Agent if the saved draft choice could not be read", async () => {
  const { result, launch } = setup(async () => {
    throw new Error("Choice read failed");
  });
  await act(async () => {
    await expect(
      result.current({ sessionId: "draft", projectId: "project", prompt: "Task" }),
    ).rejects.toThrow("Choice read failed");
  });
  expect(launch).not.toHaveBeenCalled();
});
