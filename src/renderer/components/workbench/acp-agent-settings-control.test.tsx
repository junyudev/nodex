import { fireEvent } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { render, settleAsyncRender } from "../../test/dom";
import {
  AcpAgentSettingsControl,
  type AcpAgentSettingsRuntime,
} from "./acp-agent-settings-control";

describe("AcpAgentSettingsControl", () => {
  test("authorizes a user-managed Agent instance with explicit installation policy", async () => {
    const update = vi.fn<AcpAgentSettingsRuntime["update"]>(async (input) => input);
    const runtime: AcpAgentSettingsRuntime = {
      read: async () => ({ instances: [] }),
      update,
    };
    const view = render(<AcpAgentSettingsControl open runtime={runtime} />);
    await settleAsyncRender();

    expect(view.getByText(/does not verify the package or its dependency bytes/i)).toBeTruthy();

    fireEvent.change(view.getByRole("textbox", { name: "Claude ACP package root" }), {
      target: { value: "/opt/agents/claude-agent-acp" },
    });
    fireEvent.change(view.getByRole("textbox", { name: "Claude ACP Node executable" }), {
      target: { value: "/opt/node/bin/node" },
    });
    fireEvent.click(view.getByRole("checkbox"));
    fireEvent.click(view.getByRole("button", { name: "Save Agent" }));
    await settleAsyncRender();

    expect(update).toHaveBeenCalledWith({
      instances: [
        {
          id: "claude-main",
          agentDefinitionId: "claude-agent-acp",
          packageRoot: "/opt/agents/claude-agent-acp",
          nodeExecutable: "/opt/node/bin/node",
          enabled: true,
          credentials: { kind: "inherit-host-profile" },
          proxy: "inherit-host",
        },
      ],
    });
  });
});
