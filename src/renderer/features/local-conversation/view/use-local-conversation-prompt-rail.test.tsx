import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import type { CodexPromptRailPreview } from "../../../../shared/codex-prompt-rail-history";
import type { ConversationPromptRailPort, ConversationPromptTurn } from "../conversation-runtime";
import type { ThreadUserMessageNavigationItem } from "../thread-stage-types";
import {
  useLocalConversationPromptRail,
  type UseLocalConversationPromptRailInput,
} from "./use-local-conversation-prompt-rail";

const turns = (count: number): ConversationPromptTurn[] =>
  Array.from({ length: count }, (_, index) => ({ turnId: `turn-${index + 1}` }));

const previews = (turnId: string): CodexPromptRailPreview[] => [
  {
    itemId: `${turnId}:prompt`,
    promptPreview: `Prompt for ${turnId}`,
    responsePreview: `Response for ${turnId}`,
    isHeartbeat: false,
  },
];

const residentItem = (
  turnId: string,
  label = "Resident prompt",
): ThreadUserMessageNavigationItem => ({
  id: `${turnId}:resident`,
  turnId,
  turnKey: turnId,
  ordinal: 1,
  label,
  responsePreview: "",
  outputs: [],
  isHeartbeat: false,
});

const port = (overrides: Partial<ConversationPromptRailPort> = {}): ConversationPromptRailPort => ({
  loadIndex: vi.fn(async () => turns(3)),
  preview: vi.fn(async (turnId: string) => previews(turnId)),
  install: vi.fn(async () => "applied" as const),
  ...overrides,
});

const renderRail = (initialProps: UseLocalConversationPromptRailInput) =>
  renderHook(
    (props: UseLocalConversationPromptRailInput) => useLocalConversationPromptRail(props),
    {
      initialProps,
    },
  );

describe("useLocalConversationPromptRail", () => {
  test("indexes every Turn, previews one on demand, and installs a Turn before revealing it", async () => {
    const rail = port({ loadIndex: vi.fn(async () => turns(1_000)) });
    const installedTarget = document.createElement("div");
    const revealInstalledTurn = vi.fn(async () => installedTarget);
    const hook = renderRail({
      port: rail,
      threadId: "thread-a",
      residentItems: [],
      revealInstalledTurn,
    });

    await waitFor(() => expect(hook.result.current.items).toHaveLength(1_000));
    expect(rail.preview).not.toHaveBeenCalled();

    await act(async () => {
      hook.result.current.previewItem(hook.result.current.items[499]!);
      await Promise.resolve();
    });
    await waitFor(() => expect(hook.result.current.items[499]?.label).toBe("Prompt for turn-500"));
    expect(rail.install).not.toHaveBeenCalled();

    let target: HTMLElement | null = null;
    await act(async () => {
      target = await hook.result.current.revealItem(hook.result.current.items[499]!, "smooth");
    });
    expect(rail.install).toHaveBeenCalledWith("turn-500", expect.any(AbortSignal));
    expect(revealInstalledTurn).toHaveBeenCalledWith("turn-500", "smooth", expect.any(AbortSignal));
    expect(target).toBe(installedTarget);
  });

  test("shows previews read with the index without another read", async () => {
    const rail = port({
      loadIndex: vi.fn(async () => [{ turnId: "run-1", previews: previews("run-1") }]),
      preview: undefined,
    });
    const hook = renderRail({ port: rail, threadId: "thread-a", residentItems: [] });

    await waitFor(() => expect(hook.result.current.items[0]?.label).toBe("Prompt for run-1"));
    await act(async () => {
      hook.result.current.previewItem(hook.result.current.items[0]!);
      await Promise.resolve();
    });
    expect(hook.result.current.items[0]?.responsePreview).toBe("Response for run-1");
  });

  test("navigates resident messages without an owner index or when its read fails", async () => {
    const resident = residentItem("turn-resident");
    const revealResidentItem = vi.fn(() => document.createElement("div"));
    const hook = renderRail({
      port: null,
      threadId: "thread-a",
      residentItems: [resident],
      revealResidentItem,
    });
    expect(hook.result.current.items).toEqual([resident]);

    const failing = port({ loadIndex: vi.fn(async () => Promise.reject(new Error("offline"))) });
    hook.rerender({
      port: failing,
      threadId: "thread-a",
      residentItems: [resident],
      revealResidentItem,
    });
    await waitFor(() => expect(failing.loadIndex).toHaveBeenCalledOnce());
    expect(hook.result.current.items).toEqual([resident]);

    await act(async () => {
      await hook.result.current.revealItem(hook.result.current.items[0]!, "instant");
    });
    expect(revealResidentItem).toHaveBeenCalledWith(resident, "instant");
    expect(failing.install).not.toHaveBeenCalled();
  });

  test("a replacement reader keeps its conversation's index until the next one arrives", async () => {
    let resolveNext: ((value: readonly ConversationPromptTurn[]) => void) | undefined;
    const first = port();
    const second = port({
      loadIndex: vi.fn(
        () =>
          new Promise<readonly ConversationPromptTurn[]>((resolve) => {
            resolveNext = resolve;
          }),
      ),
    });
    const hook = renderRail({ port: first, threadId: "thread-a", residentItems: [] });
    await waitFor(() => expect(hook.result.current.items).toHaveLength(3));

    hook.rerender({ port: second, threadId: "thread-a", residentItems: [] });
    expect(hook.result.current.items).toHaveLength(3);
    await act(async () => {
      resolveNext?.(turns(4));
      await Promise.resolve();
    });
    await waitFor(() => expect(hook.result.current.items).toHaveLength(4));

    hook.rerender({ port: null, threadId: "thread-b", residentItems: [] });
    expect(hook.result.current.items).toEqual([]);
  });

  test("retires a late preview from a replaced reader and previews through its replacement", async () => {
    let resolvePreview: ((value: readonly CodexPromptRailPreview[]) => void) | undefined;
    const first = port({
      preview: vi.fn(async (turnId: string) =>
        turnId === "turn-1"
          ? new Promise<readonly CodexPromptRailPreview[]>((resolve) => {
              resolvePreview = resolve;
            })
          : previews(turnId),
      ),
    });
    const hook = renderRail({ port: first, threadId: "thread-a", residentItems: [] });
    await waitFor(() => expect(hook.result.current.items).toHaveLength(3));
    await act(async () => {
      hook.result.current.previewItem(hook.result.current.items[2]!);
      await Promise.resolve();
    });
    await waitFor(() => expect(hook.result.current.items[2]?.label).toBe("Prompt for turn-3"));
    await act(async () => {
      hook.result.current.previewItem(hook.result.current.items[0]!);
      await Promise.resolve();
    });

    const replacement = port();
    hook.rerender({ port: replacement, threadId: "thread-a", residentItems: [] });
    await act(async () => {
      resolvePreview?.(previews("turn-1"));
      await Promise.resolve();
    });
    expect(hook.result.current.items[0]?.label).toBe("Load prompt preview");
    expect(hook.result.current.items[2]?.label).toBe("Load prompt preview");

    await act(async () => {
      hook.result.current.previewItem(hook.result.current.items[0]!);
      await Promise.resolve();
    });
    await waitFor(() => expect(hook.result.current.items[0]?.label).toBe("Prompt for turn-1"));
    expect(replacement.preview).toHaveBeenCalledWith("turn-1", expect.any(AbortSignal));
  });

  test("navigation outlives its reader's replacement but not a conversation change", async () => {
    let finishInstall: (() => void) | undefined;
    const installing = port({
      install: vi.fn(
        (_turnId: string, _signal: AbortSignal) =>
          new Promise<"applied">((resolve) => {
            finishInstall = () => resolve("applied");
          }),
      ),
    });
    const revealInstalledTurn = vi.fn(async (_turnId: string, _mode, signal: AbortSignal) =>
      signal.aborted ? null : document.createElement("div"),
    );
    const hook = renderRail({
      port: installing,
      threadId: "thread-a",
      residentItems: [],
      revealInstalledTurn,
    });
    await waitFor(() => expect(hook.result.current.items).toHaveLength(3));

    let navigation: Promise<HTMLElement | null> | undefined;
    await act(async () => {
      navigation = hook.result.current.revealItem(hook.result.current.items[1]!, "smooth");
      await Promise.resolve();
    });
    // Installing history publishes a new reader for the same conversation.
    hook.rerender({ port: port(), threadId: "thread-a", residentItems: [], revealInstalledTurn });
    let target: HTMLElement | null = null;
    await act(async () => {
      finishInstall?.();
      target = (await navigation) ?? null;
    });
    expect(target).not.toBeNull();
    expect(revealInstalledTurn).toHaveBeenCalledWith("turn-2", "smooth", expect.any(AbortSignal));

    hook.rerender({
      port: installing,
      threadId: "thread-a",
      residentItems: [],
      revealInstalledTurn,
    });
    await act(async () => {
      navigation = hook.result.current.revealItem(hook.result.current.items[2]!, "smooth");
      await Promise.resolve();
    });
    const signal = vi.mocked(installing.install).mock.calls.at(-1)?.[1];
    expect(vi.mocked(installing.install).mock.calls.at(-1)?.[0]).toBe("turn-3");
    hook.rerender({ port: null, threadId: "thread-b", residentItems: [] });
    await act(async () => {
      finishInstall?.();
      target = (await navigation) ?? null;
    });
    expect(signal?.aborted).toBe(true);
    expect(target).toBeNull();
  });
});
