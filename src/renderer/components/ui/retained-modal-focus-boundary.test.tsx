import { act, render, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { describe, expect, test } from "vite-plus/test";
import { NodexRetainedModalFocusBoundary } from "./retained-modal-focus-boundary";

function Modal({ open, label, children }: { open: boolean; label: string; children?: ReactNode }) {
  const [boundary, setBoundary] = useState<HTMLDivElement | null>(null);
  const [modal, setModal] = useState<HTMLDivElement | null>(null);
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  return (
    <div ref={setBoundary}>
      <button ref={setTrigger} hidden={open} type="button">
        Open {label}
      </button>
      <NodexRetainedModalFocusBoundary
        open={open}
        boundaryElement={boundary}
        modalElement={modal}
        triggerElement={trigger}
        onClose={() => {}}
      >
        <div ref={setModal} role={open ? "dialog" : undefined} aria-label={label} tabIndex={-1}>
          <button type="button">Close {label}</button>
          {children}
        </div>
      </NodexRetainedModalFocusBoundary>
    </div>
  );
}
function Harness({ open, nested = false }: { open: boolean; nested?: boolean }) {
  return (
    <>
      <section data-testid="background" aria-live="polite">
        <input aria-label="Composer" />
        <span role="status">Working</span>
      </section>
      <section data-testid="previously-inert" inert>
        <button type="button">Unavailable</button>
      </section>
      <Modal open={open} label="Preview">
        <Modal open={nested} label="Follow-up" />
      </Modal>
    </>
  );
}

describe("retained modal background ownership", () => {
  test("makes a background containing live announcements inert and restores previous state", async () => {
    const view = render(<Harness open={false} />);
    const background = view.getByTestId("background");
    const previous = view.getByTestId("previously-inert");
    previous.setAttribute("inert", "pre-existing");
    view.rerender(<Harness open />);
    await waitFor(() => expect(background.hasAttribute("inert")).toBe(true));
    const composer = background.querySelector("input");
    expect(composer?.closest("[inert]")).toBe(background);
    const modal = view.getByRole("dialog", { name: "Preview" });
    expect(modal.closest("[inert]")).toBeNull();
    view.rerender(<Harness open={false} />);
    await waitFor(() => expect(background.hasAttribute("inert")).toBe(false));
    expect(previous.getAttribute("inert")).toBe("pre-existing");
  });

  test("closing a nested modal retains the outer background claim", async () => {
    const view = render(<Harness open />);
    const background = view.getByTestId("background");
    await waitFor(() => expect(background.hasAttribute("inert")).toBe(true));
    view.rerender(<Harness open nested />);
    await view.findByRole("dialog", { name: "Follow-up" });
    view.rerender(<Harness open />);
    await waitFor(() => expect(background.hasAttribute("inert")).toBe(true));
    view.rerender(<Harness open={false} />);
    await waitFor(() => expect(background.hasAttribute("inert")).toBe(false));
  });

  test("background UI mounted during the modal is fenced and released on unmount", async () => {
    const view = render(<Harness open />);
    const late = document.createElement("section");
    late.innerHTML = '<span role="status">Updated</span><input aria-label="Late editor" />';
    try {
      await act(async () => {
        document.body.append(late);
      });
      await waitFor(() => expect(late.hasAttribute("inert")).toBe(true));
      view.unmount();
      await waitFor(() => expect(late.hasAttribute("inert")).toBe(false));
    } finally {
      late.remove();
    }
  });
});
