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
    supportsConversationProviderControl(
      { kind: "claude", controls: { steer: true } },
      "permissionMode",
    ),
  ).toBe(false);
  expect(supportsConversationProviderControl(undefined, "steer")).toBe(true);
  expect(supportsConversationProviderControl({ kind: "claude" }, "images")).toBe(false);
  expect(
    supportsConversationProviderControl({ kind: "claude", controls: { images: true } }, "images"),
  ).toBe(true);
});
