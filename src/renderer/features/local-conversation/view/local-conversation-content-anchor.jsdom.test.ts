import { describe, expect, test } from "vite-plus/test";
import {
  resolveConversationContentAnchor,
  type ConversationContentAnchor,
} from "./local-conversation-content-anchor";

describe("conversation content anchor identity", () => {
  test("follows the same message when a prepend renumbers search units and remounts its leaf", () => {
    const root = document.createElement("div");
    const element = document.createElement("div");
    element.setAttribute("data-conversation-item-key", "resident");
    element.setAttribute("data-content-search-unit-key", "turn:user:0");
    root.append(element);
    const anchor: ConversationContentAnchor = {
      element,
      attribute: "data-conversation-item-key",
      key: "resident",
      topWithinViewportPx: 56,
    };
    root.innerHTML = `<div data-conversation-item-key="older" data-content-search-unit-key="turn:user:0"></div><div data-conversation-item-key="resident" data-content-search-unit-key="turn:user:2"></div>`;

    expect(resolveConversationContentAnchor([anchor], root)?.element).toBe(root.lastElementChild);
  });

  test("selects a surviving native leaf after a renamed row releases the first visible segment", () => {
    const root = document.createElement("div");
    root.innerHTML = `<section data-turn-key="voice:older"><div data-native-realtime-item-id="resident" data-content-search-unit-key="voice:older:resident"></div></section>`;
    const anchors: ConversationContentAnchor[] = ["released", "resident"].map((key, index) => ({
      element: null,
      attribute: "data-native-realtime-item-id",
      key,
      topWithinViewportPx: index * 100 - 20,
    }));

    const resolved = resolveConversationContentAnchor(anchors, root);

    expect(resolved?.element).toBe(root.querySelector("[data-native-realtime-item-id]"));
    expect(resolved?.anchor).toBe(anchors[1]);
    expect(resolved?.anchor.topWithinViewportPx).toBe(80);
  });

  test("does not restore a leaf that moved outside the mounted transcript", () => {
    const root = document.createElement("div");
    const element = document.createElement("div");
    element.setAttribute("data-content-search-unit-key", "turn:user:0");
    const anchor: ConversationContentAnchor = {
      element,
      attribute: "data-content-search-unit-key",
      key: "turn:user:0",
      topWithinViewportPx: 12,
    };
    expect(resolveConversationContentAnchor([anchor], root)).toBeNull();

    root.append(element);
    expect(resolveConversationContentAnchor([anchor], root)?.element).toBe(element);
    element.remove();
    expect(resolveConversationContentAnchor([anchor], root)).toBeNull();
  });
});
