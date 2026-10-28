import { describe, expect, test } from "vite-plus/test";
import {
  DEFAULT_SESSION_CONTENT_SIDE,
  isSessionConversationVisible,
  oppositeWorkbenchPanelSide,
  resolveSessionWorkspacePresentation,
} from "./workbench-session-workspace";

describe("Session workspace presentation", () => {
  test.each([
    { fullWidth: false, collapsed: false, layout: "split", fullViewSurface: null, visible: true },
    { fullWidth: false, collapsed: true, layout: "chat", fullViewSurface: null, visible: true },
    {
      fullWidth: true,
      collapsed: false,
      layout: "full",
      fullViewSurface: "content",
      visible: false,
    },
    {
      fullWidth: true,
      collapsed: true,
      layout: "full",
      fullViewSurface: "conversation",
      visible: true,
    },
  ] as const)(
    "fullWidth=$fullWidth, collapsed=$collapsed presents $layout/$fullViewSurface",
    ({ fullWidth, collapsed, layout, fullViewSurface, visible }) => {
      const presentation = resolveSessionWorkspacePresentation({
        fullWidth,
        collapsed,
        side: undefined,
        preferredSide: DEFAULT_SESSION_CONTENT_SIDE,
      });
      expect(presentation).toEqual({ layout, fullViewSurface, contentSide: "right" });
      expect(isSessionConversationVisible(presentation)).toBe(visible);
    },
  );

  test.each([
    { side: undefined, preferredSide: "left", expected: "left" },
    { side: undefined, preferredSide: "right", expected: "right" },
    { side: "left", preferredSide: "right", expected: "left" },
    { side: "right", preferredSide: "left", expected: "right" },
  ] as const)(
    "saved side $side takes precedence over preference $preferredSide",
    ({ side, preferredSide, expected }) => {
      expect(
        resolveSessionWorkspacePresentation({
          fullWidth: false,
          collapsed: false,
          side,
          preferredSide,
        }).contentSide,
      ).toBe(expected);
    },
  );

  test.each([
    ["left", "right"],
    ["right", "left"],
  ] as const)("the Conversation takes the opposite side of %s", (contentSide, chatSide) => {
    expect(oppositeWorkbenchPanelSide(contentSide)).toBe(chatSide);
    expect(oppositeWorkbenchPanelSide(chatSide)).toBe(contentSide);
  });
});
