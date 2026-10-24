import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { createAcpAgentsOwner } from "./acp-agents-owner";
import { fakeAcpRuntime, memoryJournal, ok, registryInstance } from "./acp-agents.test-fixtures";
import { AcpModelServices } from "./acp-model-services";

const press = async (element: HTMLElement) =>
  act(async () => {
    fireEvent.pointerDown(element, { button: 0 });
    fireEvent.click(element);
    await Promise.resolve();
  });

const type = async (element: HTMLElement, value: string) =>
  act(async () => {
    fireEvent.change(element, { target: { value } });
    await Promise.resolve();
  });

const services = {
  providers: [
    {
      providerId: "openai",
      supported: ["openai"],
      required: true,
      current: { apiType: "openai", baseUrl: "https://api.openai.test/v1" },
    },
    { providerId: "deepseek", supported: ["openai"], required: false, current: null },
  ],
};

function mount() {
  const main = fakeAcpRuntime({ instances: [registryInstance()] });
  main.runtime.listModelProviders.mockResolvedValue(ok(services));
  const owner = createAcpAgentsOwner({
    runtime: main.runtime,
    subscribeChanges: () => () => {},
    journal: memoryJournal(),
  });
  const view = renderWithAppMaitai(
    <NodexTooltipProvider delay={0}>
      <AcpModelServices instanceId="qoder-main" owner={owner} />
    </NodexTooltipProvider>,
  );
  return { main, view };
}

describe("ACP model services", () => {
  test("a required service can be edited but not turned off", async () => {
    const { view } = mount();
    await view.findByText(/https:\/\/api\.openai\.test\/v1 · Required/);
    expect(view.queryAllByRole("button", { name: "Turn off" })).toHaveLength(0);
    expect(view.getByRole("button", { name: "Configure" })).toBeTruthy();
  });

  test("configuring sends the endpoint and write-only headers, then shows the Agent's list", async () => {
    const { main, view } = mount();
    main.runtime.setModelProvider.mockResolvedValue(
      ok({
        providers: [
          services.providers[0]!,
          {
            ...services.providers[1]!,
            current: { apiType: "openai", baseUrl: "https://api.deepseek.test/v1" },
          },
        ],
      }),
    );
    await press(await view.findByRole("button", { name: "Configure" }));
    await type(view.getByLabelText("deepseek base URL"), "https://user:pw@api.deepseek.test/v1");
    await press(view.getByRole("button", { name: "Save" }));
    await view.findByText("Enter an http or https URL without credentials.");
    expect(main.runtime.setModelProvider).not.toHaveBeenCalled();

    await type(view.getByLabelText("deepseek base URL"), "https://api.deepseek.test/v1");
    await press(view.getByRole("button", { name: "Add header" }));
    await type(view.getByLabelText("Header name 1"), "Authorization");
    await type(view.getByLabelText("Header value 1"), "Bearer secret");
    await press(view.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(main.runtime.setModelProvider).toHaveBeenCalledWith({
        instanceId: "qoder-main",
        providerId: "deepseek",
        apiType: "openai",
        baseUrl: "https://api.deepseek.test/v1",
        headers: { Authorization: "Bearer secret" },
      }),
    );
    await view.findByText(/api\.deepseek\.test/);
    expect(view.queryByDisplayValue("Bearer secret")).toBeNull();
  });

  test("a busy credential scope refuses the write with how many chats to stop", async () => {
    const { main, view } = mount();
    main.runtime.setModelProvider.mockResolvedValue({
      ok: false,
      error: {
        reason: "busy",
        message: "busy",
        affectedSessions: [{ sessionId: "s", threadId: "t" }],
      },
    });
    await press(await view.findByRole("button", { name: "Configure" }));
    await type(view.getByLabelText("deepseek base URL"), "https://api.deepseek.test/v1");
    await press(view.getByRole("button", { name: "Save" }));
    await view.findByText("In use by 1 chat. Stop it first.");
  });
});
