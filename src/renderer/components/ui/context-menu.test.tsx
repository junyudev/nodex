import { act, fireEvent } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { render } from "@/test/dom";
import {
  NodexContextMenuContent,
  NodexContextMenuItem,
  NodexContextMenuPortal,
  NodexContextMenuRoot,
  NodexContextMenuSubmenu,
  NodexContextMenuSubmenuTrigger,
  NodexContextMenuTrigger,
} from "./context-menu";

function TestMenu({ onResolve }: { readonly onResolve: (id: string) => void }) {
  const submenu = (id: string) => (
    <NodexContextMenuSubmenu
      trigger={<NodexContextMenuSubmenuTrigger>{id}</NodexContextMenuSubmenuTrigger>}
      renderContent={() => {
        onResolve(id);
        return <NodexContextMenuItem>{id} child</NodexContextMenuItem>;
      }}
    />
  );
  return (
    <NodexContextMenuRoot>
      <NodexContextMenuTrigger>
        <button type="button">Target</button>
      </NodexContextMenuTrigger>
      <NodexContextMenuPortal>
        <NodexContextMenuContent>
          {submenu("First")}
          {submenu("Second")}
          <NodexContextMenuItem>Plain action</NodexContextMenuItem>
        </NodexContextMenuContent>
      </NodexContextMenuPortal>
    </NodexContextMenuRoot>
  );
}

const openRoot = async (target: HTMLElement): Promise<void> => {
  await act(async () => {
    fireEvent.contextMenu(target, { clientX: 40, clientY: 40 });
    await Promise.resolve();
  });
};

const hoverItem = async (item: HTMLElement): Promise<void> => {
  await act(async () => {
    fireEvent.pointerMove(item, {
      pointerType: "mouse",
      movementX: 0,
      movementY: 2,
    });
    await Promise.resolve();
  });
};

describe("NodexContextMenuSubmenu", () => {
  test("does not resolve submenu content until the pointer opens it", async () => {
    const onResolve = vi.fn();
    const view = render(<TestMenu onResolve={onResolve} />);

    await openRoot(view.getByRole("button", { name: "Target" }));
    expect(onResolve).not.toHaveBeenCalled();

    await hoverItem(view.getByRole("menuitem", { name: "First" }));
    await view.findByRole("menuitem", { name: "First child" });
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenLastCalledWith("First");
  });

  test("switches and dismisses sibling submenus without a delay timer", async () => {
    const view = render(<TestMenu onResolve={() => undefined} />);
    await openRoot(view.getByRole("button", { name: "Target" }));

    await hoverItem(view.getByRole("menuitem", { name: "First" }));
    await view.findByRole("menuitem", { name: "First child" });

    await hoverItem(view.getByRole("menuitem", { name: "Second" }));
    expect(view.getByRole("menuitem", { name: "Second child" })).toBeTruthy();
    expect(view.queryByRole("menuitem", { name: "First child" })).toBeNull();

    await hoverItem(view.getByRole("menuitem", { name: "Plain action" }));
    expect(view.queryByRole("menuitem", { name: "Second child" })).toBeNull();
  });
});
