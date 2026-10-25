import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { AcpAgentSetupDialog } from "./acp-agent-setup-dialog";
import { createAcpAgentsOwner } from "./acp-agents-owner";
import {
  deferred,
  fakeAcpRuntime,
  memoryJournal,
  ok,
  operation,
  registryInstance,
} from "./acp-agents.test-fixtures";

const press = async (element: HTMLElement) =>
  act(async () => {
    fireEvent.pointerDown(element, { button: 0 });
    fireEvent.click(element);
    await Promise.resolve();
  });

describe("ACP Agent setup", () => {
  test("Cancel keeps focus until the step it cancelled is offered again", async () => {
    const qoder = registryInstance();
    const main = fakeAcpRuntime({ instances: [qoder] });
    const cancelling = deferred<void>();
    main.runtime.cancelOperation.mockImplementation(async ({ operationId }) => {
      await cancelling.promise;
      return ok(
        operation({ operationId, kind: "connect", phase: "cancelled", instanceId: qoder.id }),
      );
    });
    const owner = createAcpAgentsOwner({
      runtime: main.runtime,
      subscribeChanges: () => () => {},
      journal: memoryJournal(),
    });
    const view = renderWithAppMaitai(
      <NodexTooltipProvider delay={0}>
        <AcpAgentSetupDialog
          owner={owner}
          instanceId={qoder.id}
          onOpenSettings={vi.fn()}
          onClose={vi.fn()}
        />
      </NodexTooltipProvider>,
    );
    const connect = await view.findByRole("button", { name: "Connect" });
    await act(async () => {
      connect.focus();
      await Promise.resolve();
    });
    await press(connect);
    const cancel = await view.findByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);

    await press(cancel);
    await waitFor(() => expect(cancel.getAttribute("aria-disabled")).toBe("true"));
    expect(document.activeElement).toBe(cancel);
    // Cancelling again while it settles asks the Runtime only once.
    await press(cancel);
    expect(main.runtime.cancelOperation).toHaveBeenCalledTimes(1);
    await act(async () => {
      cancelling.resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(view.getByRole("button", { name: "Connect" })),
    );
  });
});
