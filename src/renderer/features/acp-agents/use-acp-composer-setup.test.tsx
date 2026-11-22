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
import { useComposerAgentSetup } from "../agent-readiness/use-composer-agent-setup";
import { agentReadinessNotice } from "../local-conversation/agent-readiness-notice";
import { getIntl } from "@/lib/i18n";
import { AgentSettingsNavigationProvider } from "@/lib/agent-settings-navigation";

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
  driver: "acpRegistry",
  instanceId: instance.id,
});

function Composer({
  owner,
  providers,
}: {
  readonly owner: AcpAgentsOwner;
  readonly providers: readonly AcpProviderSnapshot[];
}) {
  const setup = useComposerAgentSetup({
    hosted: false,
    acpOwner: owner,
    instances: [
      { binding: binding(qoder), label: "Qoder", enabled: true },
      { binding: binding(scripted), label: "Scripted", enabled: true },
    ],
    refreshCatalog: () => {},
    checkCatalogAgain: async () => {},
  });
  const setups = setup.setupRows(providers);
  const selected = binding(qoder);
  const readiness = setup.read(
    selected,
    providers.find(({ instanceId }) => instanceId === selected.instanceId),
  );
  const notice = readiness
    ? agentReadinessNotice(
        selected.instanceId,
        "Qoder",
        readiness,
        () => setup.run(selected, readiness.action),
        getIntl(),
      )
    : null;
  return (
    <NodexTooltipProvider delay={0}>
      <ul aria-label="Setup">
        {setups.map((setup) => (
          <li key={setup.label}>{`${setup.label}: ${setup.hint}`}</li>
        ))}
      </ul>
      {notice ? (
        <p>
          {notice.title}
          {notice.actions?.map((action) => (
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
    main.accounts.read.mockResolvedValue(
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
      accountRuntime: main.accounts,
      subscribeChanges: () => () => {},
      journal: memoryJournal(),
    });
    const openSettings = vi.fn();
    const view = renderWithAppMaitai(
      <AgentSettingsNavigationProvider
        openAgentSettings={(_, instanceId) => openSettings(instanceId)}
      >
        <Composer owner={owner} providers={providers} />
      </AgentSettingsNavigationProvider>,
    );
    expect(view.getByRole("list", { name: "Setup" }).textContent).toBe(
      "Qoder: Sign inScripted: Install",
    );
    view.getByText("Qoder isn’t signed in");

    await press(view.getByRole("button", { name: "Sign in" }));
    const dialog = await view.findByRole("dialog");
    const signIn = await view.findByRole("button", { name: "Sign in with Qoder account" });
    await press(signIn);
    await waitFor(() =>
      expect(main.accounts.start).toHaveBeenCalledWith({
        backend: { driver: "acpRegistry", instanceId: "qoder-main" },
        methodId: "agent",
      }),
    );
    await press(view.getByRole("button", { name: "Settings" }));
    expect(openSettings).toHaveBeenCalledWith("qoder-main");
    await waitFor(() => expect(dialog.isConnected).toBe(false));
  });
});
