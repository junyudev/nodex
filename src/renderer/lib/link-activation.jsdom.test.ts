import { expect, test } from "vite-plus/test";
import { isEligibleMarkdownLinkContext, snapshotLinkActivation } from "./link-activation";

test.each([
  [null, null, false, false, true],
  ["main", null, false, false, false],
  ["main", "tabpanel", false, false, true],
  ["main", null, false, true, true],
  [null, "tabpanel", true, false, false],
  ["main", "tabpanel", true, true, false],
] as const)(
  "Markdown context %s/%s controller=%s fullWidth=%s",
  (area, role, controller, fullWidth, expected) => {
    const region = document.createElement("div");
    if (area) region.setAttribute("data-app-shell-focus-area", area);
    if (role) region.setAttribute("role", role);
    if (controller) region.setAttribute("data-app-shell-tab-panel-controller", "right");
    const anchor = document.createElement("a");
    region.append(anchor);
    expect(
      isEligibleMarkdownLinkContext(anchor, {
        platform: "darwin",
        ...(fullWidth ? { metaKey: true, altKey: true } : {}),
      }),
    ).toBe(expected);
  },
);
test("captures a detached value and normalizes macOS platform spelling", () => {
  const event = new MouseEvent("auxclick", { button: 1, metaKey: true, shiftKey: true });
  expect(snapshotLinkActivation(event, "MacIntel")).toEqual({
    button: 1,
    metaKey: true,
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
    platform: "darwin",
  });
});
