import * as Effect from "effect/Effect";
import type { WorkbenchSubmitPresentation } from "../../shared/nodex-app-tools/workbench";
import { WorkbenchAgentBridge } from "../app-tools/WorkbenchAgentBridge";
import { make } from "./CodexTurnPresentation";

export const testSubmitPresentation: WorkbenchSubmitPresentation = {
  rendererGeneration: "renderer-a",
  sceneOwner: { kind: "pages" },
  presentationRevision: 7,
  selectedTabs: [],
  focusedTarget: { tabId: "tab-page", panelId: "right", groupId: "group-a" },
};

export const makeTestTurnPresentation = make.pipe(
  Effect.provideService(
    WorkbenchAgentBridge,
    WorkbenchAgentBridge.of({
      referenceForSender: (id: number) =>
        id === 11
          ? { windowSessionId: "window-a", rendererGeneration: "renderer-a" }
          : id === 22
            ? { windowSessionId: "window-b", rendererGeneration: "renderer-b" }
            : null,
    } as unknown as WorkbenchAgentBridge["Service"]),
  ),
);
