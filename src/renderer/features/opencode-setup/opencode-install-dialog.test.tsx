import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { NodexModalHost } from "@/lib/modal-registry";
import { renderWithAppMaitai } from "@/test/app-maitai";
import type { OpenCodeSetupState } from "../../../shared/opencode-setup";
import { openOpenCodeInstallDialog } from "./opencode-install-dialog";
import { createOpenCodeSetupOwner, type OpenCodeSetupOwner } from "./opencode-setup-owner";
import {
  OPENCODE_INSTALL_COMMAND,
  fakeSetupRuntime,
  readyExecutable,
  setupState,
} from "./opencode-setup.test-fixtures";

const running = (revision: number, lines: string[], progress: number | null) =>
  setupState(revision, { installation: { phase: "running", log: { lines, progress } } });
const failed = (
  revision: number,
  reason: "timeout" | "existing-installation",
  message: string,
): OpenCodeSetupState =>
  setupState(revision, {
    installation: {
      phase: "failed",
      log: { lines: ["curl: (28) Operation timed out"], progress: 0.3 },
      reason,
      message,
    },
  });

interface HarnessProps {
  readonly owner: OpenCodeSetupOwner;
  readonly rowMounted?: boolean;
  readonly onShowModels?: () => void;
  readonly onParentPointerDown?: () => void;
}

function Harness({ owner, rowMounted = true, onShowModels, onParentPointerDown }: HarnessProps) {
  const appHandle = useScopeHandle(appScope);
  return (
    <NodexTooltipProvider delay={0}>
      <div onPointerDown={onParentPointerDown}>
        {rowMounted ? (
          <button
            type="button"
            onClick={() => openOpenCodeInstallDialog(appHandle, { owner, onShowModels })}
          >
            Free OpenCode models
          </button>
        ) : null}
      </div>
      <NodexModalHost />
    </NodexTooltipProvider>
  );
}

const press = async (element: HTMLElement) =>
  act(async () => {
    fireEvent.pointerDown(element, { button: 0 });
    fireEvent.click(element);
    await Promise.resolve();
  });

async function openDialog(
  main: ReturnType<typeof fakeSetupRuntime>,
  props: Omit<HarnessProps, "owner" | "rowMounted"> = {},
) {
  const owner = createOpenCodeSetupOwner(main.runtime, vi.fn());
  const view = renderWithAppMaitai(<Harness owner={owner} {...props} />);
  await press(view.getByRole("button", { name: "Free OpenCode models" }));
  const dialog = await view.findByRole("dialog", { name: "Install OpenCode" });
  return { view, dialog, owner };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenCode install dialog", () => {
  test("opens to the official command and runs it only from the dialog's Install action", async () => {
    const main = fakeSetupRuntime(setupState(1));
    main.runtime.install.mockImplementation(async () => {
      main.set(running(2, ["Installing opencode version: 2.0.18"], 0.42));
      return running(2, ["Installing opencode version: 2.0.18"], 0.42);
    });
    const parent = vi.fn();
    const { view, dialog, owner } = await openDialog(main, { onParentPointerDown: parent });
    await within(dialog).findByText(`$ ${OPENCODE_INSTALL_COMMAND}`);
    expect(within(dialog).queryByRole("progressbar")).toBeNull();
    expect(main.runtime.install).not.toHaveBeenCalled();

    await press(within(dialog).getByRole("button", { name: "Install" }));
    expect(main.runtime.install).toHaveBeenCalledOnce();
    await within(dialog).findByText("Installing opencode version: 2.0.18");
    const progress = within(dialog).getByRole("progressbar", { name: "Installation progress" });
    expect(progress.getAttribute("aria-valuenow")).toBe("42");
    expect(within(dialog).getByText("42%")).toBeTruthy();

    // Output without a reported share keeps progress indeterminate.
    await act(async () => {
      main.emit(running(3, ["Installing opencode version: 2.0.18", "Extracting"], null));
    });
    await within(dialog).findByText(/Extracting/);
    expect(
      within(dialog)
        .getByRole("progressbar", { name: "Installation progress" })
        .hasAttribute("aria-valuenow"),
    ).toBe(false);

    // The registry owns the dialog: it ignores its trigger's ancestors and outlives the menu row.
    parent.mockClear();
    fireEvent.pointerDown(within(dialog).getByText("Install OpenCode"));
    expect(parent).not.toHaveBeenCalled();
    view.rerender(<Harness owner={owner} rowMounted={false} onParentPointerDown={parent} />);
    expect(view.queryByRole("button", { name: "Free OpenCode models", hidden: true })).toBeNull();
    expect(view.getByRole("dialog", { name: "Install OpenCode" })).toBeTruthy();

    // Dismissing hides the dialog; Main keeps installing.
    await press(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    expect(main.runtime.cancel).not.toHaveBeenCalled();
  });

  test("copies the exact official command", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      const main = fakeSetupRuntime(setupState(1));
      const { dialog } = await openDialog(main);
      await press(await within(dialog).findByRole("button", { name: "Copy command" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(OPENCODE_INSTALL_COMMAND));
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  test("returns to the model menu after success without choosing a model", async () => {
    const main = fakeSetupRuntime(running(1, ["Installing"], 0.1));
    const onShowModels = vi.fn();
    const { view, dialog } = await openDialog(main, { onShowModels });
    await act(async () => {
      main.emit(
        setupState(2, {
          executable: readyExecutable(),
          installation: { phase: "succeeded", log: { lines: ["Installing", "Done"], progress: 1 } },
        }),
      );
    });
    expect((await within(dialog).findByRole("status")).textContent).toBe(
      "OpenCode 2.0.18 is ready",
    );
    expect(within(dialog).queryByRole("progressbar")).toBeNull();
    await press(within(dialog).getByRole("button", { name: "Show free models" }));
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    expect(onShowModels).toHaveBeenCalledOnce();
  });

  test("keeps a failure's output and retries only failures another attempt can fix", async () => {
    const main = fakeSetupRuntime(running(1, [], null));
    const { dialog } = await openDialog(main);
    await act(async () => {
      main.emit(failed(2, "timeout", "OpenCode installation timed out."));
    });
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "OpenCode installation timed out.",
    );
    expect(within(dialog).getByText("curl: (28) Operation timed out")).toBeTruthy();
    main.runtime.install.mockResolvedValueOnce(running(3, [], null));
    await press(within(dialog).getByRole("button", { name: "Retry" }));
    expect(main.runtime.install).toHaveBeenCalledOnce();
    await within(dialog).findByRole("button", { name: "Cancel" });

    await act(async () => {
      main.emit(
        failed(
          4,
          "existing-installation",
          "An existing OpenCode installation will not be replaced.",
        ),
      );
    });
    await within(dialog).findByText("An existing OpenCode installation will not be replaced.");
    expect(within(dialog).queryByRole("button", { name: "Retry" })).toBeNull();
    expect(within(dialog).getAllByRole("button", { name: "Close" }).length).toBeGreaterThan(0);
  });

  test("Cancel stops the installer and closes once Main confirms", async () => {
    const main = fakeSetupRuntime(running(1, ["Installing"], 0.2));
    const { view, dialog } = await openDialog(main);
    main.runtime.cancel.mockRejectedValueOnce(new Error("The installer is still stopping."));
    await press(within(dialog).getByRole("button", { name: "Cancel" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "The installer is still stopping.",
    );
    main.runtime.cancel.mockResolvedValueOnce(setupState(2));
    await press(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    expect(main.runtime.cancel).toHaveBeenCalledTimes(2);
  });
});
