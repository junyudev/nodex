import { expect, test } from "vite-plus/test";
import { supportsConversationProviderControl } from "./conversation-provider-controls";

test("native controls require a positive advertised capability", () => {
  expect(supportsConversationProviderControl({ kind: "claude" }, "steer")).toBe(false);
  expect(
    supportsConversationProviderControl({ kind: "claude", controls: { steer: true } }, "steer"),
  ).toBe(true);
  expect(
    supportsConversationProviderControl({ kind: "acp", controls: { skills: true } }, "skills"),
  ).toBe(true);
  expect(
    supportsConversationProviderControl({ kind: "claude", controls: { steer: true } }, "stopTask"),
  ).toBe(false);
  expect(supportsConversationProviderControl(undefined, "steer")).toBe(true);
  expect(supportsConversationProviderControl({ kind: "claude" }, "images")).toBe(false);
  expect(
    supportsConversationProviderControl({ kind: "claude", controls: { images: true } }, "images"),
  ).toBe(true);
});

test("explicit Runtime capabilities override native Codex defaults", () => {
  expect(supportsConversationProviderControl({ kind: "codex" }, "images")).toBe(true);
  expect(
    supportsConversationProviderControl({ kind: "codex", controls: { images: false } }, "images"),
  ).toBe(false);
  expect(
    supportsConversationProviderControl({ kind: "codex", controls: { images: true } }, "images"),
  ).toBe(true);
});
