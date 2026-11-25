import { describe, expect, it } from "vite-plus/test";
import {
  decideNodexReferenceOpen,
  parseNodexDestination,
  type NodexReferenceGesture,
  type NodexReferenceSurface,
} from "./nodex-reference";

const mac = (keys: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>> = {}) =>
  ({ kind: "activate", activation: { button: 0, platform: "darwin", ...keys } }) as const;
const middle = (shiftKey = false) =>
  ({ kind: "activate", activation: { button: 1, platform: "darwin", shiftKey } }) as const;

describe("parseNodexDestination", () => {
  it("reads Page, View and chat links with their Space", () => {
    expect(parseNodexDestination("nodex://pages/p1")).toEqual({ kind: "page", pageId: "p1" });
    expect(parseNodexDestination("nodex://pages/p1#b1")).toEqual({
      kind: "page",
      pageId: "p1",
      blockId: "b1",
    });
    expect(parseNodexDestination("nodex://views/v1?spaceId=s1")).toEqual({
      kind: "view",
      viewId: "v1",
      spaceId: "s1",
    });
    expect(parseNodexDestination("nodex://sessions/c1")).toEqual({
      kind: "session",
      sessionId: "c1",
    });
  });

  it("ignores everything else", () => {
    for (const href of ["https://example.com", "thread://abc", "nodex://files/f1", "", null])
      expect(parseNodexDestination(href)).toBeNull();
  });
});

describe("decideNodexReferenceOpen", () => {
  const content = (surface: NodexReferenceSurface, gesture: NodexReferenceGesture) =>
    decideNodexReferenceOpen({ destination: { kind: "page" }, surface, gesture });

  it("previews content beside a chat or an Inbox, and keeps it in place from a Page", () => {
    expect(content("conversation", mac())).toEqual({
      kind: "content",
      placement: "beside",
      mode: "preview",
      activate: true,
    });
    expect(content("inbox", mac())).toMatchObject({ placement: "beside", mode: "preview" });
    expect(content("page", mac())).toMatchObject({ placement: "source-group", mode: "durable" });
    expect(content("workbench", mac())).toMatchObject({ placement: "home", mode: "durable" });
  });

  it("keeps a preview on double-click and from Open in New Tab", () => {
    for (const gesture of [{ kind: "keep" }, { kind: "menu", action: "new-tab" }] as const)
      expect(content("conversation", gesture)).toEqual({
        kind: "content",
        placement: "beside",
        mode: "durable",
        activate: true,
      });
  });

  it("opens a background tab on Primary or middle, and brings it forward with Shift", () => {
    for (const gesture of [mac({ metaKey: true }), middle()])
      expect(content("conversation", gesture)).toMatchObject({ mode: "durable", activate: false });
    for (const gesture of [mac({ metaKey: true, shiftKey: true }), middle(true)])
      expect(content("page", gesture)).toMatchObject({
        placement: "source-group",
        mode: "durable",
        activate: true,
      });
  });

  it("uses Ctrl as Primary off macOS", () => {
    const ctrl = { kind: "activate", activation: { button: 0, platform: "win32", ctrlKey: true } };
    const meta = { kind: "activate", activation: { button: 0, platform: "win32", metaKey: true } };
    expect(content("conversation", ctrl as NodexReferenceGesture)).toMatchObject({
      activate: false,
    });
    expect(content("conversation", meta as NodexReferenceGesture)).toMatchObject({
      mode: "preview",
    });
  });

  it("goes to the content's own Scene on Primary+Alt; Alt alone is a plain activation", () => {
    expect(content("conversation", mac({ metaKey: true, altKey: true }))).toMatchObject({
      placement: "home",
      activate: true,
    });
    expect(content("conversation", mac({ altKey: true }))).toMatchObject({ mode: "preview" });
  });

  it("goes to a chat, and opens it additionally in a new window", () => {
    const session = (gesture: NodexReferenceGesture) =>
      decideNodexReferenceOpen({
        destination: { kind: "session" },
        surface: "conversation",
        gesture,
      });
    expect(session(mac())).toEqual({ kind: "session" });
    expect(session({ kind: "keep" })).toEqual({ kind: "session" });
    expect(session(mac({ metaKey: true, altKey: true }))).toEqual({ kind: "session" });
    for (const gesture of [
      mac({ metaKey: true }),
      mac({ metaKey: true, shiftKey: true }),
      middle(),
      { kind: "menu", action: "new-tab" },
      { kind: "menu", action: "new-window" },
    ] as const)
      expect(session(gesture)).toEqual({ kind: "new-window" });
  });

  it("opens content in a new window from the menu", () => {
    expect(content("page", { kind: "menu", action: "new-window" })).toEqual({
      kind: "new-window",
    });
  });
});
