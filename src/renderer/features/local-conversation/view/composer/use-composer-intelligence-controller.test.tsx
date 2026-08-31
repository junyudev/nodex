import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { CodexServiceTierSettingsProvider } from "@/lib/use-codex-service-tier-settings";
import type { ThreadFooterModel, ThreadStageActions } from "../../thread-stage-types";
import type { ComposerIntelligenceSelection } from "./composer-intelligence-selection";
import { useComposerIntelligenceController } from "./use-composer-intelligence-controller";

const mocks = vi.hoisted(() => ({
  toastDanger: vi.fn(),
}));

vi.mock("@/components/ui/toast", () => ({
  toast: {
    danger: mocks.toastDanger,
  },
}));

const AUTHORITATIVE_SELECTION = {
  kind: "codex",
  model: "gpt-5.6-terra",
  reasoningEffort: "low",
  serviceTier: null,
} satisfies ComposerIntelligenceSelection;

const FIRST_SELECTION = {
  kind: "codex",
  model: "gpt-5.6-sol",
  reasoningEffort: "medium",
  serviceTier: null,
} satisfies ComposerIntelligenceSelection;

const LATEST_SELECTION = {
  kind: "codex",
  model: "gpt-5.6-sol",
  reasoningEffort: "xhigh",
  serviceTier: "fast",
} satisfies ComposerIntelligenceSelection;

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function buildModel(): ThreadFooterModel {
  return {
    selectedModel: AUTHORITATIVE_SELECTION.model,
    selectedReasoningEffort: AUTHORITATIVE_SELECTION.reasoningEffort,
    executionProfile: null,
    conversation: {
      latestThreadSettings: { serviceTier: AUTHORITATIVE_SELECTION.serviceTier },
    },
  } as ThreadFooterModel;
}

function buildNewThreadAgentModel(): ThreadFooterModel {
  return {
    ...buildModel(),
    isNewThreadTab: true,
    executionProfile: {
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      serviceTier: null,
    },
  } as ThreadFooterModel;
}

function provider({ children }: { children: ReactNode }) {
  return <CodexServiceTierSettingsProvider>{children}</CodexServiceTierSettingsProvider>;
}

describe("useComposerIntelligenceController", () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.toastDanger.mockReset();
  });

  test("publishes one trigger ref for the lifetime of the controller", () => {
    const actions = {} as unknown as ThreadStageActions;
    const hook = renderHook(() => useComposerIntelligenceController(buildModel(), actions), {
      wrapper: provider,
    });
    const triggerRef = hook.result.current.triggerRef;

    hook.rerender();

    expect(hook.result.current.triggerRef).toBe(triggerRef);
  });

  test("preserves a semantically unchanged new-task agent selection across rerenders", () => {
    const actions = {} as unknown as ThreadStageActions;
    const hook = renderHook(
      () => useComposerIntelligenceController(buildNewThreadAgentModel(), actions),
      { wrapper: provider },
    );
    const selection = hook.result.current.selection;

    hook.rerender();

    expect(hook.result.current.selection).toBe(selection);
  });

  test("keeps the latest optimistic selection and skips superseded work after an older failure", async () => {
    const firstCommit = deferred();
    const commits: ComposerIntelligenceSelection[] = [];
    const onIntelligenceSelectionChange = vi.fn(
      async (selection: ComposerIntelligenceSelection) => {
        commits.push(selection);
        if (commits.length === 1) await firstCommit.promise;
      },
    );
    const actions = {
      onIntelligenceSelectionChange,
    } as unknown as ThreadStageActions;
    const hook = renderHook(() => useComposerIntelligenceController(buildModel(), actions), {
      wrapper: provider,
    });

    act(() => {
      hook.result.current.select(FIRST_SELECTION);
    });
    act(() => {
      hook.result.current.select({ ...FIRST_SELECTION, reasoningEffort: "high" });
      hook.result.current.select(LATEST_SELECTION);
    });
    expect(hook.result.current.selection).toEqual(LATEST_SELECTION);

    firstCommit.reject(new Error("Older selection failed"));
    await act(async () => {
      await hook.result.current.flush();
    });

    expect(commits).toEqual([FIRST_SELECTION, LATEST_SELECTION]);
    expect(hook.result.current.selection).toEqual(LATEST_SELECTION);
    expect(hook.result.current.isPending).toBe(false);
    expect(mocks.toastDanger).not.toHaveBeenCalled();
  });

  test("rolls back the final failed selection and makes flush report the failure", async () => {
    const actions = {
      onIntelligenceSelectionChange: vi.fn(async () => {
        throw new Error("Could not save selection");
      }),
    } as unknown as ThreadStageActions;
    const hook = renderHook(() => useComposerIntelligenceController(buildModel(), actions), {
      wrapper: provider,
    });

    act(() => {
      hook.result.current.select(LATEST_SELECTION);
    });
    expect(hook.result.current.selection).toEqual(LATEST_SELECTION);

    await act(async () => {
      await expect(hook.result.current.flush()).rejects.toThrow("Could not save selection");
    });

    expect(hook.result.current.selection).toEqual(AUTHORITATIVE_SELECTION);
    expect(hook.result.current.isPending).toBe(false);
    expect(mocks.toastDanger).toHaveBeenCalledWith("Could not save selection");
  });
});
