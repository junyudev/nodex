import { describe, expect, test, vi } from "vite-plus/test";
import { fireEvent, waitFor } from "@testing-library/react";
import { act } from "react";
import { settleAsyncRender } from "@/test/dom";
import { renderWithMaitai as render } from "@/test/thread-maitai";
import { NodexModalHost } from "@/lib/modal-registry";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import {
  BranchSelectorPopover,
  resolveBranchSearchEnterAction,
  validateCreateBranchName,
} from "./branch-selector-popover";

describe("branch selector popover", () => {
  test("renders as a dropdown menu instead of a selector popover shell", async () => {
    let view!: ReturnType<typeof render>;

    await act(async () => {
      view = render(
        <NodexTooltipProvider>
          <BranchSelectorPopover
            cwd="/Users/asc/repo/nodex"
            busy={false}
            state={{
              currentBranch: "main",
              defaultBranch: "main",
              branches: ["main", "feature/dropdown"],
            }}
            onRefresh={async () => {}}
            onCheckout={async () => true}
            onCreate={async () => true}
          />
          <NodexModalHost />
        </NodexTooltipProvider>,
      );
    });

    await act(async () => {
      const trigger = view.getByLabelText("Switch branch");
      expect(trigger.hasAttribute("title")).toBe(false);
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await settleAsyncRender();
    });

    const content = view.container.ownerDocument.body.querySelector(
      '[data-slot="dropdown-content"]',
    );
    const popover = view.container.ownerDocument.body.querySelector(
      '[data-slot="popover-content"]',
    );
    const searchInput = view.container.ownerDocument.body.querySelector(
      'input[placeholder="Search branches"]',
    );

    expect(content).not.toBeNull();
    expect(popover === null).toBe(true);
    expect(searchInput).not.toBeNull();
    expect(
      view.container.ownerDocument.body.textContent?.includes("Create and checkout new branch") ??
        false,
    ).toBe(true);
  });

  test("matches reference search Enter behavior", () => {
    expect(
      resolveBranchSearchEnterAction({
        search: "",
        branches: ["main"],
        currentBranch: "main",
        disabled: false,
      }).kind,
    ).toBe("close");
    expect(
      resolveBranchSearchEnterAction({
        search: "new",
        branches: [],
        currentBranch: "main",
        disabled: false,
      }).kind,
    ).toBe("none");
    const checkoutAction = resolveBranchSearchEnterAction({
      search: "feature",
      branches: ["main", "feature/existing"],
      currentBranch: "main",
      disabled: false,
    });
    expect(checkoutAction.kind).toBe("checkout");
    expect(checkoutAction.kind === "checkout" ? checkoutAction.branch : null).toBe(
      "feature/existing",
    );
    expect(
      resolveBranchSearchEnterAction({
        search: "feature",
        branches: ["feature/existing"],
        currentBranch: "main",
        disabled: true,
      }).kind,
    ).toBe("none");
  });

  test("validates create branch names", () => {
    const existing = new Set(["main", "feature/existing"]);

    expect(validateCreateBranchName("", existing)).toBe("empty");
    expect(validateCreateBranchName("feature/new/", existing)).toBe("trailing-slash");
    expect(validateCreateBranchName("feature/existing", existing)).toBe("exists");
    expect(validateCreateBranchName("feature/new", existing)).toBe(null);
  });

  test("opens create dialog from the bottom action", async () => {
    let view!: ReturnType<typeof render>;

    await act(async () => {
      view = render(
        <NodexTooltipProvider>
          <BranchSelectorPopover
            cwd="/Users/asc/repo/nodex"
            busy={false}
            state={{
              currentBranch: "main",
              defaultBranch: "main",
              branches: ["main", "feature/existing"],
            }}
            onRefresh={async () => {}}
            onCheckout={async () => true}
            onCreate={async () => true}
          />
          <NodexModalHost />
        </NodexTooltipProvider>,
      );
    });

    await act(async () => {
      const trigger = view.getByLabelText("Switch branch");
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await settleAsyncRender();
    });

    await act(async () => {
      fireEvent.click(view.getByText("Create and checkout new branch"));
      await settleAsyncRender();
    });

    expect(
      view.container.ownerDocument.body.textContent?.includes("Create and checkout branch") ??
        false,
    ).toBe(true);
    const branchNameInput = view.container.ownerDocument.body.querySelector(
      'input[aria-label="Branch name"]',
    );
    if (!(branchNameInput instanceof HTMLInputElement))
      throw new Error("Expected branch name input");
    expect((view.getByText("Create and checkout") as HTMLButtonElement).disabled).toBe(true);
  });

  test("renders branch menu loading and error states", async () => {
    let retryCalls = 0;
    let view!: ReturnType<typeof render>;

    await act(async () => {
      view = render(
        <NodexTooltipProvider>
          <BranchSelectorPopover
            cwd="/Users/asc/repo/nodex"
            busy={false}
            loading
            state={{
              currentBranch: null,
              defaultBranch: null,
              branches: [],
            }}
            onRefresh={async () => {
              retryCalls += 1;
            }}
            onCheckout={async () => true}
            onCreate={async () => true}
          />
          <NodexModalHost />
        </NodexTooltipProvider>,
      );
    });

    await act(async () => {
      const trigger = view.getByLabelText("Switch branch");
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await settleAsyncRender();
    });
    expect(
      view.container.ownerDocument.body.textContent?.includes("Loading branches…") ?? false,
    ).toBe(true);

    await act(async () => {
      view.rerender(
        <NodexTooltipProvider>
          <BranchSelectorPopover
            cwd="/Users/asc/repo/nodex"
            busy={false}
            error
            state={{
              currentBranch: null,
              defaultBranch: null,
              branches: [],
            }}
            onRefresh={async () => {
              retryCalls += 1;
            }}
            onCheckout={async () => true}
            onCreate={async () => true}
          />
          <NodexModalHost />
        </NodexTooltipProvider>,
      );
      await settleAsyncRender();
    });

    expect(
      view.container.ownerDocument.body.textContent?.includes("Unable to load branches") ?? false,
    ).toBe(true);
    await act(async () => {
      fireEvent.click(view.getByText("Retry"));
      await settleAsyncRender();
    });
    expect(retryCalls).toBe(2);
  });
  test("owns branch creation outside its trigger and survives that trigger unmounting", async () => {
    const parentPointer = vi.fn();
    const create = vi.fn(async (_branch: string) => true);
    const view = render(
      <NodexTooltipProvider>
        <div onPointerDown={parentPointer}>
          <BranchSelectorPopover
            cwd="/repo"
            busy={false}
            state={{ currentBranch: "main", branches: ["main"] }}
            onRefresh={async () => {}}
            onCheckout={async () => true}
            onCreate={create}
          />
        </div>
        <NodexModalHost />
      </NodexTooltipProvider>,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Switch branch" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(
        await view.findByRole("menuitem", { name: "Create and checkout new branch" }),
      );
      await Promise.resolve();
    });
    const title = await view.findByRole("heading", { name: "Create and checkout branch" });
    parentPointer.mockClear();
    await act(async () => {
      fireEvent.pointerDown(title);
      await Promise.resolve();
    });
    expect(parentPointer).not.toHaveBeenCalled();
    await act(async () => {
      view.rerender(
        <NodexTooltipProvider>
          <NodexModalHost />
        </NodexTooltipProvider>,
      );
      await Promise.resolve();
    });
    expect(view.getByRole("dialog", { name: "Create and checkout branch" })).toBeTruthy();
    await act(async () => {
      fireEvent.change(view.getByRole("textbox", { name: "Branch name" }), {
        target: { value: "feature/review" },
      });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Create and checkout" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(create).toHaveBeenCalledWith("feature/review"));
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  });
});
