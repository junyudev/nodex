import { describe, expect, test } from "bun:test";
import {
  createSideMenuFreezeController,
  deleteSideMenuBlock,
} from "./side-menu-freeze-controller";

describe("createSideMenuFreezeController", () => {
  test("freezes once and releases once across repeated open state changes", () => {
    const calls: string[] = [];
    const controller = createSideMenuFreezeController({
      freezeMenu: () => {
        calls.push("freeze");
      },
      unfreezeMenu: () => {
        calls.push("unfreeze");
      },
    });

    controller.handleMenuOpenChange(true);
    controller.handleMenuOpenChange(true);
    controller.handleMenuOpenChange(false);
    controller.handleMenuOpenChange(false);

    expect(calls.join(",")).toBe("freeze,unfreeze");
  });

  test("release only unfreezes when the menu was previously frozen", () => {
    const calls: string[] = [];
    const controller = createSideMenuFreezeController({
      freezeMenu: () => {
        calls.push("freeze");
      },
      unfreezeMenu: () => {
        calls.push("unfreeze");
      },
    });

    controller.release();
    controller.handleMenuOpenChange(true);
    controller.release();
    controller.release();

    expect(calls.join(",")).toBe("freeze,unfreeze");
  });
});

describe("deleteSideMenuBlock", () => {
  test("releases the frozen side menu before removing the block", () => {
    const calls: string[] = [];

    deleteSideMenuBlock({
      block: "block-1",
      editor: {
        removeBlocks: (blocks) => {
          calls.push(`remove:${blocks.join("|")}`);
        },
      },
      releaseSideMenuFreeze: () => {
        calls.push("release");
      },
    });

    expect(calls.join(",")).toBe("release,remove:block-1");
  });
});
