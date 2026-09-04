import { lazy, useState, type ComponentType } from "react";
import { act, fireEvent } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { appScope, type ScopeHandle, useScopeHandle } from "@/lib/maitai";
import { renderWithMaitai } from "../test/thread-maitai";
import {
  closeModal,
  isModalOpen,
  NodexModalHost,
  openModal,
  type ModalCloseProps,
} from "./modal-registry";

function captureAppHandle(capture: (handle: ScopeHandle) => void) {
  function HandleProbe() {
    capture(useScopeHandle(appScope));
    return null;
  }

  return HandleProbe;
}

function requireHandle(handle: ScopeHandle | null): ScopeHandle {
  if (!handle) throw new Error("Expected an app scope handle");
  return handle;
}

interface TestModalProps extends ModalCloseProps {
  readonly label: string;
}

function StatefulModal({ label, onClose }: TestModalProps) {
  const [count, setCount] = useState(0);
  return (
    <section aria-label={label}>
      <output>{count}</output>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        Increment {label}
      </button>
      <button type="button" onClick={onClose}>
        Close {label}
      </button>
    </section>
  );
}

function OtherModal({ label, onClose }: TestModalProps) {
  return (
    <section aria-label={label}>
      <button type="button" onClick={onClose}>
        Close {label}
      </button>
    </section>
  );
}

describe("modal registry", () => {
  test("stacks distinct components and moves a reopened component to the top without remounting it", () => {
    let appHandle: ScopeHandle | null = null;
    const HandleProbe = captureAppHandle((handle) => {
      appHandle = handle;
    });
    const view = renderWithMaitai(
      <>
        <HandleProbe />
        <NodexModalHost />
      </>,
    );
    const handle = requireHandle(appHandle);

    act(() => {
      openModal(handle, StatefulModal, { label: "First" });
    });
    fireEvent.click(view.getByRole("button", { name: "Increment First" }));
    expect(view.getByRole("region", { name: "First" }).textContent).toContain("1");

    act(() => {
      openModal(handle, OtherModal, { label: "Second" });
      openModal(handle, StatefulModal, { label: "First updated" });
    });

    const regions = view.getAllByRole("region");
    expect(regions.map((region) => region.getAttribute("aria-label"))).toEqual([
      "Second",
      "First updated",
    ]);
    expect(view.getByRole("region", { name: "First updated" }).textContent).toContain("1");
  });

  test("runs the caller close callback before removing the component", () => {
    let appHandle: ScopeHandle | null = null;
    const HandleProbe = captureAppHandle((handle) => {
      appHandle = handle;
    });
    const onClose = vi.fn(() => {
      expect(isModalOpen(requireHandle(appHandle), StatefulModal)).toBe(true);
    });
    const view = renderWithMaitai(
      <>
        <HandleProbe />
        <NodexModalHost />
      </>,
    );
    const handle = requireHandle(appHandle);

    act(() => {
      openModal(handle, StatefulModal, { label: "Closable", onClose });
    });
    fireEvent.click(view.getByRole("button", { name: "Close Closable" }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(isModalOpen(handle, StatefulModal)).toBe(false);
    expect(view.queryByRole("region", { name: "Closable" })).toBe(null);

    act(() => {
      closeModal(handle, StatefulModal);
    });
    expect(isModalOpen(handle, StatefulModal)).toBe(false);
  });

  test("isolates a suspending modal entry from the rest of the host", async () => {
    let appHandle: ScopeHandle | null = null;
    const HandleProbe = captureAppHandle((handle) => {
      appHandle = handle;
    });
    let resolveLazy: ((module: { default: ComponentType<TestModalProps> }) => void) | null = null;
    const LazyModal = lazy(
      () =>
        new Promise<{
          default: ComponentType<TestModalProps>;
        }>((resolve) => {
          resolveLazy = resolve;
        }),
    );
    const view = renderWithMaitai(
      <>
        <HandleProbe />
        <NodexModalHost />
      </>,
    );
    const handle = requireHandle(appHandle);

    act(() => {
      openModal(handle, OtherModal, { label: "Ready" });
      openModal(handle, LazyModal, { label: "Lazy" });
    });
    expect(view.getByRole("region", { name: "Ready" })).toBeTruthy();
    expect(view.queryByRole("region", { name: "Lazy" })).toBe(null);

    await act(async () => {
      resolveLazy?.({ default: StatefulModal });
      await Promise.resolve();
    });
    expect(await view.findByRole("region", { name: "Lazy" })).toBeTruthy();
  });
});
