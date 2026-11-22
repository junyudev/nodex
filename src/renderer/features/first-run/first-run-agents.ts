import { useIntl } from "@/lib/i18n";
import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toastFailure } from "@/lib/failure-toast";
import { useFirstRunBrowserSignIn } from "../agent-readiness/use-browser-agent-sign-in";
import { useWorkbenchWindowOwner } from "@/lib/use-workbench-window-state";
import { buildSettingsAnchorPath } from "@/components/workbench/workbench-settings-routes";
import { APP_COMPONENTS_SETTINGS_ANCHOR } from "@/features/app-components/app-components-settings-section";
import { useAppComponents } from "@/features/app-components/use-app-components";
import { useModelPolicy } from "@/features/model-policy/model-policy";
import { resolveNodexAccountView } from "@/features/nodex-account/nodex-account-identity";
import {
  useNodexAccount,
  useNodexCreditRefreshOnFocus,
} from "@/features/nodex-account/use-nodex-account";
import { openOpenCodeInstallDialog } from "@/features/opencode-setup/opencode-install-dialog";
import {
  openCodeInstallationReadiness,
  openCodeInstallView,
} from "@/features/opencode-setup/opencode-setup-model";
import { openCodeSetupOwner, useOpenCodeSetup } from "@/features/opencode-setup/use-opencode-setup";
import { antigravityAgent } from "../../../shared/agents/antigravity";
import { openCodeAgent } from "../../../shared/agents/opencode";
import { sameAgentDriver } from "../../../shared/agents/registry";
import { antigravityInstallationReadiness } from "../antigravity-runtime/antigravity-runtime-model";
import { publishAgentCatalogRefresh } from "@/lib/agent-catalog-refresh";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { queryKeys } from "@/lib/query-keys";
import { useAgentRuntimeProviders } from "@/lib/use-agent-runtime-providers";
import { nodexCreditBalance } from "../../../shared/nodex-account";
import { withFreeModelsOn } from "../../../shared/model-policy";
import { acpInstanceStatus } from "../acp-agents/acp-agent-model";
import { acpAgentsOwner, useAcpAgents } from "../acp-agents/use-acp-agents";
import {
  antigravityRuntimeOwner,
  useAntigravityRuntime,
} from "../antigravity-runtime/antigravity-runtime-owner";
import { useProviderKeys } from "../provider-keys/use-provider-keys";
import {
  arrangeFirstRunAgents,
  firstRunAgentRows,
  firstRunAgentsSettled,
  placeFirstRunAgents,
  type FirstRunAgentInputs,
  type FirstRunAgentPlace,
  type FirstRunAgentRow,
} from "./first-run-model";

/**
 * How long the page waits for every Agent's first answer before giving rows their places. A slow
 * check, such as an Agent waiting on the network, then keeps its row without holding the others.
 */
const PLACEMENT_GRACE_MS = 3_000;

/** Every Agent the first step offers, read from the owners the rest of the app already uses. */
export function useFirstRunAgents() {
  const intl = useIntl();
  const client = useQueryClient();
  const appHandle = useScopeHandle(appScope);
  const workbench = useWorkbenchWindowOwner();
  const providers = useAgentRuntimeProviders();
  const components = useAppComponents();
  const policy = useModelPolicy();
  const nodexAccount = useNodexAccount(true);
  const nodexView = resolveNodexAccountView(nodexAccount, intl);
  const openCodeSetup = useOpenCodeSetup(openCodeSetupOwner, true);
  const acp = useAcpAgents(acpAgentsOwner);
  const antigravity = useAntigravityRuntime();
  const providerKeys = useProviderKeys();
  const installView = openCodeInstallView(openCodeSetup);

  const refresh = useCallback(async () => {
    // What is installed can change while the person is away, as much as who is signed in.
    const scanned = antigravityRuntimeOwner.run("check");
    try {
      const next = await agentRuntimeRuntime.catalog({ refresh: true });
      client.setQueryData(queryKeys.agentRuntime.providers(), next);
    } catch {
      // The last answer stays on screen; the Composer reports what stays unusable.
    }
    await scanned;
    publishAgentCatalogRefresh();
  }, [client]);

  // One check at a time: a second request joins the one in flight, and its rows show the wait.
  const [checkingAgain, setCheckingAgain] = useState<Promise<void> | null>(null);
  const checkAgain = useCallback(() => {
    if (checkingAgain) return checkingAgain;
    const run = refresh().finally(() => setCheckingAgain(null));
    setCheckingAgain(run);
    return run;
  }, [checkingAgain, refresh]);

  const browserSignIn = useFirstRunBrowserSignIn(() => void refresh());

  // Signing in, installing and updating finish in a browser or a terminal, so coming back checks
  // again without the page showing a wait nobody asked for.
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // A payment finishes in the browser too, and the balance decides whether the row is ready.
  const { refreshModels } = nodexAccount;
  useNodexCreditRefreshOnFocus(nodexView.signedIn, refreshModels);
  useEffect(() => {
    if (nodexView.signedIn) refreshModels();
  }, [nodexView.signedIn, refreshModels]);

  const openCodeInstalled = installView.kind === "ready";
  const nodexSignedIn = nodexView.signedIn;
  useEffect(() => {
    if (openCodeInstalled || nodexSignedIn) void refresh();
  }, [refresh, nodexSignedIn, openCodeInstalled]);

  useEffect(() => {
    void antigravityRuntimeOwner.run("check");
  }, []);

  const inputs: FirstRunAgentInputs = {
    providers: providers.data ?? (providers.isError ? [] : null),
    policy: policy.settings,
    pendingBrowserSignIn: browserSignIn.pending,
    nodex: {
      configured: nodexView.configured,
      signedIn: nodexView.signedIn,
      signingIn: nodexView.signingIn,
      identity: nodexView.identity?.label ?? null,
      balance: nodexCreditBalance(nodexAccount.snapshot),
      notice: nodexView.notice?.message ?? null,
    },
    installations: {
      components: components.state?.components ?? [],
      managed: {
        [openCodeAgent.setup.installation.id]: () =>
          (installView.kind === "idle" && !installView.supported) ||
          installView.kind === "unreadable"
            ? undefined
            : openCodeInstallationReadiness(installView),
        [antigravityAgent.setup.installation.id]: (provider) => {
          if (
            provider?.installed &&
            provider.auth.status === "authenticated" &&
            provider.status !== "error"
          )
            return undefined;
          if (!antigravity.error && !antigravity.state?.inspection)
            return { problem: { kind: "checking" } };
          const installation = antigravityInstallationReadiness(antigravity, provider?.instanceId);
          if (installation || provider) return installation;
          return { problem: { kind: "not-connected" }, found: true };
        },
      },
    },
    acpAgents: acp.settings
      ? acp.settings.instances.map((instance) => ({
          id: instance.id,
          label: instance.displayName,
          agentDefinitionId: instance.agentDefinitionId,
          status: acpInstanceStatus({
            instance,
            inspection: acp.inspections.get(instance.id),
            provider: acp.providers.get(instance.id),
            activity: acp.activities.get(instance.id),
          }),
        }))
      : acp.loadError
        ? []
        : null,
    providerKeys: providerKeys.settings?.connections ?? (providerKeys.loadError ? [] : null),
  };
  const rows = firstRunAgentRows(inputs, intl);

  // Rows take their places on the first complete answer, or after a short grace when one Agent is
  // slow to answer, and then hold still under the pointer. A slot that arrives later joins its tier.
  const settled = firstRunAgentsSettled(inputs, rows);
  const [graceOver, setGraceOver] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setGraceOver(true), PLACEMENT_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, []);
  const [places, setPlaces] = useState<readonly FirstRunAgentPlace[] | null>(null);
  if (settled || graceOver) {
    const next = placeFirstRunAgents(places ?? [], rows);
    if (next !== places) setPlaces(next);
  }

  const run = async (action: NonNullable<FirstRunAgentRow["action"]>) => {
    switch (action.kind) {
      case "browser-sign-in":
        if (action.sourceId === browserSignIn.owner) await browserSignIn.begin();
        return;
      case "cancel-browser-sign-in":
        await browserSignIn.cancel();
        return;
      case "nodex-sign-in":
        nodexAccount.act("signIn");
        return;
      case "nodex-cancel-sign-in":
        nodexAccount.act("cancelSignIn");
        return;
      case "installer":
        if (action.sourceId === openCodeAgent.setup.installation.id)
          openOpenCodeInstallDialog(appHandle, { owner: openCodeSetupOwner });
        return;
      case "use-free-models":
        await policy.updateSettings(
          (providers.data ?? [])
            .filter((provider) => sameAgentDriver(provider.driver, action.binding?.driver ?? ""))
            .reduce(withFreeModelsOn, policy.settings),
        );
        publishAgentCatalogRefresh();
        return;
      case "connect":
        if (action.target) acpAgentsOwner.connect(action.target);
        return;
      case "check-again":
        await checkAgain();
        return;
      case "component-settings":
        workbench.openRoute({
          kind: "settings",
          path: buildSettingsAnchorPath("general-settings", APP_COMPONENTS_SETTINGS_ANCHOR),
        });
        return;
      case "component-retry":
        if (action.componentId) await components.retry(action.componentId);
        return;
      case "agent-settings":
      case "terminal-sign-in":
      case "terminal-install":
      case "inline-sign-in":

      case "api-key-add":
        return;
    }
  };

  return {
    rows: arrangeFirstRunAgents(rows, places),
    settled,
    checkingAgain: checkingAgain !== null,
    anyReady: rows.some((row) => row.state === "ready"),
    nodexAccount,
    providerKeys,
    acp,
    checkAgain: refresh,
    run: (action: NonNullable<FirstRunAgentRow["action"]>) =>
      run(action).catch((cause: unknown) =>
        toastFailure(
          intl.formatMessage({
            id: "firstRun.firstRunAgents.couldnTConnectThatAgent",
            defaultMessage: "Couldn’t connect that Agent",
          }),
          cause,
        ),
      ),
    useBrowserApiKey: async (apiKey: string) => {
      await browserSignIn.submitKey(apiKey);
      await refresh();
    },
  };
}
