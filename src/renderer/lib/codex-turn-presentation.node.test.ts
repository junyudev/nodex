import { describe, expect, test, vi, afterEach } from "vite-plus/test";
import {
  captureCodexTurnPresentation,
  readCodexSubmissionPresentation,
} from "./codex-turn-presentation";
import { CodexTurnPresentationCaptureInputSchema } from "../../shared/nodex-app-tools/turn-presentation";
import type { WorkbenchSubmitPresentation } from "../../shared/nodex-app-tools/workbench";

const mocks = vi.hoisted(() => ({ capture: vi.fn(), invoke: vi.fn() }));
vi.mock("./workbench-agent-bridge", () => ({ captureWorkbenchSubmitPresentation: mocks.capture }));
vi.mock("./renderer-command", () => ({ invokeRendererControl: mocks.invoke }));
afterEach(() => vi.resetAllMocks());
const owner = {} as Parameters<typeof readCodexSubmissionPresentation>[0];
const target = { kind: "thread", threadId: "thread-a" } as const;
const available: WorkbenchSubmitPresentation = {
  rendererGeneration: "generation-a",
  sceneOwner: { kind: "pages" },
  presentationRevision: 7,
  focusedTarget: null,
  selectedTabs: [],
};

describe("optional submission presentation", () => {
  test.each([null, { ...available, selectedTabs: [{ malformed: true }] }])(
    "captures explicit absence when optional metadata is unavailable or malformed",
    async (value) => {
      mocks.capture.mockReturnValue(value);
      const submitted = readCodexSubmissionPresentation(owner);
      expect(submitted).toMatchObject({
        availability: "unavailable",
        sceneOwner: null,
        selectedTabs: [],
      });
      mocks.capture.mockReturnValue(available);
      mocks.invoke.mockResolvedValue(undefined);
      await expect(captureCodexTurnPresentation(owner, target, submitted)).resolves.toBeUndefined();
      expect(mocks.capture).toHaveBeenCalledTimes(1);
      expect(mocks.invoke).toHaveBeenCalledWith("codex:turn-presentation:capture", {
        target,
        presentation: submitted,
      });
    },
  );

  test("a failing optional projection cannot throw from the user submit event", () => {
    mocks.capture.mockImplementation(() => {
      throw new Error("malformed panel");
    });
    expect(readCodexSubmissionPresentation(owner).availability).toBe("unavailable");
  });

  test("freezes the originating event and keeps real control authorization failures visible", async () => {
    const live = structuredClone(available);
    mocks.capture.mockReturnValue(live);
    const submitted = readCodexSubmissionPresentation(owner);
    live.rendererGeneration = "generation-b";
    mocks.invoke.mockRejectedValue(new Error("untrusted sender"));
    await expect(captureCodexTurnPresentation(owner, target, submitted)).rejects.toThrow(
      "untrusted sender",
    );
    expect(mocks.invoke).toHaveBeenCalledWith("codex:turn-presentation:capture", {
      target,
      presentation: available,
    });
  });

  test("the IPC boundary discards malformed optional evidence but rejects an invalid message target", () => {
    expect(
      CodexTurnPresentationCaptureInputSchema.parse({ target, presentation: { corrupt: true } })
        .presentation.availability,
    ).toBe("unavailable");
    expect(
      CodexTurnPresentationCaptureInputSchema.safeParse({
        target: { kind: "thread", threadId: "" },
        presentation: available,
      }).success,
    ).toBe(false);
  });
});
