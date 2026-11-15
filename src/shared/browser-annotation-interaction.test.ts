import { expect, test } from "vite-plus/test";
import {
  browserAnnotationDefaultAction,
  browserAnnotationKeyAction,
  browserAnnotationAvailability,
} from "./browser-annotation-interaction";
const key = {
  key: "Enter",
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  isComposing: false,
  repeat: false,
};
test("batch saves by default and quick sends, with the modifier selecting the other action", () => {
  expect(browserAnnotationDefaultAction("batch")).toBe("save");
  expect(browserAnnotationDefaultAction("quick")).toBe("send");
  for (const flow of ["batch", "quick"] as const) {
    expect(browserAnnotationKeyAction({ ...key, flow })).toBe(flow === "batch" ? "save" : "send");
    expect(browserAnnotationKeyAction({ ...key, flow, metaKey: true })).toBe(
      flow === "batch" ? "send" : "save",
    );
    expect(browserAnnotationKeyAction({ ...key, flow, ctrlKey: true })).toBe(
      flow === "batch" ? "send" : "save",
    );
  }
});
test.each([{ shiftKey: true }, { isComposing: true }, { repeat: true }, { key: "a" }])(
  "does not submit %j",
  (patch) => {
    expect(browserAnnotationKeyAction({ ...key, flow: "batch", ...patch })).toBeNull();
  },
);
test("suspension and Agent control gate interaction without changing the requested mode", () => {
  const wanted = { enabled: true, suspended: false, agentControlled: false };
  expect(browserAnnotationAvailability({ ...wanted, suspended: true })).toBe(false);
  expect(browserAnnotationAvailability({ ...wanted, agentControlled: true })).toBe(false);
  expect(browserAnnotationAvailability(wanted)).toBe(true);
  expect(browserAnnotationAvailability({ ...wanted, enabled: false })).toBe(false);
});
