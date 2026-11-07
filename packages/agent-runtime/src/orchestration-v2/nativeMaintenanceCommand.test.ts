import { expect, it } from "vite-plus/test";

import { isNativeCompactCommand, isNativeMaintenanceCommand } from "./nativeMaintenanceCommand.ts";

const message = (text: string, records: ReadonlyArray<{ kind: string }> = []) => ({
  text,
  attachments: [],
  context: {
    version: 1 as const,
    records: records.map((record) => ({ ...record, label: "Plan", payload: {} })),
  },
});

it("recognizes a command that stands alone", () => {
  expect(isNativeCompactCommand(message(" /Compact\n"))).toBe(true);
  expect(isNativeMaintenanceCommand(message("/logout"))).toBe(true);
  expect(isNativeCompactCommand({ text: "/compact", attachments: [] })).toBe(true);
  expect(isNativeCompactCommand(message("/compact later"))).toBe(false);
});

it("treats a command with attached context as an ordinary prompt", () => {
  const attached = message("/compact", [{ kind: "nodex-page-reference" }]);
  expect(isNativeCompactCommand(attached)).toBe(false);
  expect(isNativeMaintenanceCommand(attached)).toBe(false);
});
