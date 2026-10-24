import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { NodexModalHost } from "@/lib/modal-registry";
import { renderWithAppMaitai } from "@/test/app-maitai";
import type { AgentBackendBinding } from "../../../shared/agent-backend";
import { acpProviderId, type AcpProviderSnapshot } from "./acp-agent-model";
import { createAcpAgentsOwner, type AcpAgentsOwner } from "./acp-agents-owner";
import {
  authState,
  fakeAcpRuntime,
  memoryJournal,
  ok,
  providerSnapshot,
  registryInstance,
} from "./acp-agents.test-fixtures";
import { useAcpComposerSetup } from "./use-acp-composer-setup";

const press = async (element: HTMLElement) =>
  act(async () => {
    fireEvent.pointerDown(element, { button: 0 });
    fireEvent.click(element);
    await Promise.resolve();
  });

const qoder = registryInstance();
const scripted = registryInstance({
  id: "scripted",
  agentDefinitionId: "scripted",
  displayName: "Scripted",
  source: { kind: "registry", agentId: "scripted", distribution: "auto" },
});
const binding = (instance: typeof qoder): AgentBackendBinding => ({
  kind: "acp",
  agentDefinitionId: instance.agentDefinitionId,
  instanceConfigId: instance.id,
});

function Composer({
  owner,
  providers,
  openSettings,
}: {
  readonly owner: AcpAgentsOwner;
  readonly providers: readonly AcpProviderSnapshot[];
  readonly openSettings: (instanceId: string) => void;
}) {
  const { setups, status } = useAcpComposerSetup({
    owner,
    providers,
    instances: [
      { binding: binding(qoder), label: "Qoder", enabled: true },
      { binding: binding(scripted), label: "Scripted", enabled: true },
      { binding: { kind: "codex" }, label: "Codex", enabled: true },
    ],
    selected: binding(qoder),
    openSettings,
  });
  return (
    <NodexTooltipProvider delay={0}>
      <ul aria-label="Setup">
        {setups.map((setup) => (
          <li key={setup.label}>{`${setup.label}: ${setup.hint}`}</li>
        ))}
      </ul>
      {status ? (
        <p>
          {status.message}
          {status.actions?.map((action) => (
            <button key={action.label} type="button" onClick={() => void action.run()}>
              {action.label}
            </button>
          ))}
        </p>
      ) : null}
      <NodexModalHost />
    </NodexTooltipProvider>
  );
}

describe("ACP setup in the Composer", () => {
  test("unusable Agents get one setup entry each and the selected one asks to sign in", async () => {
    const main = fakeAcpRuntime({ instances: [qoder, scripted] });
    main.runtime.readAuth.mockResolvedValue(
      ok(
        authState({
          methods: [{ id: "agent", name: "Qoder account", description: null, type: "agent" }],
        }),
      ),
    );
    const providers = [
      providerSnapshot({ instanceId: acpProviderId(qoder)!, auth: { status: "unauthenticated" } }),
      providerSnapshot({ instanceId: acpProviderId(scripted)!, installed: false }),
    ];
    main.runtime.knownProviders.mockResolvedValue(providers);
    const owner = createAcpAgentsOwner({
      runtime: main.runtime,
      subscribeChanges: () => () => {},
      journal: memoryJournal(),
    });
    const openSettings = vi.fn();
    const view = renderWithAppMaitai(
      <Composer owner={owner} providers={providers} openSettings={openSettings} />,
    );
    expect(view.getByRole("list", { name: "Setup" }).textContent).toBe(
      "Qoder: Sign inScripted: Install",
    );
    view.getByText("Sign in to Qoder to send messages.");

    await press(view.getByRole("button", { name: "Sign in" }));
    const dialog = await view.findByRole("dialog");
    const signIn = await view.findByRole("button", { name: "Sign in with Qoder account" });
    await press(signIn);
    await waitFor(() =>
      expect(main.runtime.startAuth).toHaveBeenCalledWith({
        instanceId: "qoder-main",
        methodId: "agent",
      }),
    );
    await press(view.getByRole("button", { name: "Settings" }));
    expect(openSettings).toHaveBeenCalledWith("qoder-main");
    await waitFor(() => expect(dialog.isConnected).toBe(false));
  });
});
