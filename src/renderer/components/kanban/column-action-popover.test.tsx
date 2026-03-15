import { describe, expect, mock, test } from "bun:test";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("radix-ui", () => ({
  Popover: {
    Root: ({ children }: { children: ReactNode }) => createElement("div", null, children),
    Trigger: ({ children }: { children: ReactNode }) => createElement("div", null, children),
    Portal: ({ children }: { children: ReactNode }) => createElement("div", null, children),
    Content: (props: {
      children: ReactNode;
      sideOffset?: unknown;
      collisionPadding?: unknown;
    } & ComponentProps<"div">) => {
      const {
        children,
        sideOffset,
        collisionPadding,
        ...contentProps
      } = props;
      void sideOffset;
      void collisionPadding;
      return createElement("div", contentProps, children);
    },
  },
}));

mock.module("../ui/selector-menu-chrome", () => ({
  SELECTOR_MENU_CONTENT_CLASS_NAME: "menu-surface",
  SELECTOR_MENU_DIVIDER_CLASS_NAME: "menu-divider",
  SELECTOR_MENU_DIVIDER_WRAPPER_CLASS_NAME: "menu-divider-wrap",
}));

mock.module("../../lib/utils", () => ({
  cn: (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" "),
}));

describe("column action popover", () => {
  test("renders collapse action and width controls for expanded columns", async () => {
    const { ColumnActionPopover } = await import("./column-action-popover");

    const markup = renderToStaticMarkup(
      createElement(ColumnActionPopover, {
        columnName: "In Progress",
        collapsed: false,
        width: 360,
        accentColor: "#336699",
        onCollapsedChange: () => undefined,
        onWidthChange: () => undefined,
      }),
    );

    expect(markup.includes('aria-label="More options for In Progress"')).toBeTrue();
    expect(markup.includes("Collapse")).toBeTrue();
    expect(markup.includes("Width")).toBeTrue();
    expect(markup.includes("360px")).toBeTrue();
  });

  test("switches the action label when the column is collapsed", async () => {
    const { ColumnActionPopover } = await import("./column-action-popover");

    const markup = renderToStaticMarkup(
      createElement(ColumnActionPopover, {
        columnName: "Done",
        collapsed: true,
        width: 288,
        accentColor: "#336699",
        onCollapsedChange: () => undefined,
        onWidthChange: () => undefined,
      }),
    );

    expect(markup.includes("Expand")).toBeTrue();
  });
});
