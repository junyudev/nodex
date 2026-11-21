import { useIntl } from "@/lib/i18n";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toastFailure } from "@/lib/failure-toast";
import { useDefaultCodexAppServerManager } from "@/features/local-conversation/local-conversation-store";
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
import { openCodeInstallView } from "@/features/opencode-setup/opencode-setup-model";
import { openCodeSetupOwner, useOpenCodeSetup } from "@/features/opencode-setup/use-opencode-setup";
import { publishAgentCatalogRefresh } from "@/lib/agent-catalog-refresh";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { queryKeys } from "@/lib/query-keys";
import { useAgentRuntimeProviders } from "@/lib/use-agent-runtime-providers";
import { useCodexAccountActions } from "@/lib/use-codex-account-actions";
import { nodexCreditBalance } from "../../../shared/nodex-account";
import { withFreeModelsOn } from "../../../shared/model-policy";
import { acpInstanceStatus } from "../acp-agents/acp-agent-model";
import { acpAgentsOwner, useAcpAgents } from "../acp-agents/use-acp-agents";
import { useLocalAgentSuggestions } from "../local-agents/use-local-agents";
import { useProviderKeys } from "../provider-keys/use-provider-keys";
import {
  arrangeFirstRunAgents,
  firstRunAgentRows,
  firstRunAgentsSettled,
  orderFirstRunAgents,
  type FirstRunAgentInputs,
  type FirstRunAgentRow,
} from "./first-run-model";

const OPENCODE_DRIVERS: readonly string[] = ["opencode", "opencode2"];

function openCodeInstallState(
  kind: ReturnType<typeof openCodeInstallView>,
): FirstRunAgentInputs["openCodeInstall"] {
  switch (kind.kind) {
    case "loading":
      return "checking";
    case "unreadable":
      return "unavailable";
    case "idle":
      return kind.supported ? "installable" : "unavailable";
    case "running":
      return "installing";
    case "ready":
      return "installed";
    default:
      return "installable";
  }
}

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
  const codexAccounts = useDefaultCodexAppServerManager();
  const codexActions = useCodexAccountActions();
  const codexAccount = useSyncExternalStore(
    (listener) => codexAccounts.subscribeAccount(listener),
    () => codexAccounts.readAccount(),
  );
  const openCodeSetup = useOpenCodeSetup(openCodeSetupOwner, true);
  const acp = useAcpAgents(acpAgentsOwner);
  const localAgents = useLocalAgentSuggestions(acpAgentsOwner);
  const providerKeys = useProviderKeys();
  const installView = openCodeInstallView(openCodeSetup);
  const pendingLogin = codexAccount?.pendingLogin ?? null;

  const checkAgain = useCallback(async () => {
    try {
      const next = await agentRuntimeRuntime.catalog({ refresh: true });
      client.setQueryData(queryKeys.agentRuntime.providers(), next);
    } catch {
      // The last answer stays on screen; the Composer reports what stays unusable.
    }
    publishAgentCatalogRefresh();
  }, [client]);

  useEffect(() => {
    void codexAccounts.loadAccount().catch(() => undefined);
  }, [codexAccounts]);

  // Signing in finishes in the browser or a terminal, so coming back checks again.
  useEffect(() => {
    const onFocus = () => void checkAgain();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [checkAgain]);

  // A payment finishes in the browser too, and the balance decides whether the row is ready.
  const { refreshModels } = nodexAccount;
  useNodexCreditRefreshOnFocus(nodexView.signedIn, refreshModels);
  useEffect(() => {
    if (nodexView.signedIn) refreshModels();
  }, [nodexView.signedIn, refreshModels]);

  const signedInToCodex = Boolean(codexAccount?.account);
  const openCodeInstalled = installView.kind === "ready";
  const nodexSignedIn = nodexView.signedIn;
  useEffect(() => {
    if (signedInToCodex || openCodeInstalled || nodexSignedIn) void checkAgain();
  }, [checkAgain, nodexSignedIn, openCodeInstalled, signedInToCodex]);

  const inputs: FirstRunAgentInputs = {
    providers: providers.data ?? (providers.isError ? [] : null),
    policy: policy.settings,
    codexLoginPending: pendingLogin !== null,
    nodex: {
      configured: nodexView.configured,
      signedIn: nodexView.signedIn,
      signingIn: nodexView.signingIn,
      identity: nodexView.identity?.label ?? null,
      balance: nodexCreditBalance(nodexAccount.snapshot),
      notice: nodexView.notice?.message ?? null,
    },
    openCodeInstall: openCodeInstallState(installView),
    localAgents: localAgents.settled ? localAgents.suggestions : null,
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
    codex: components.state?.components.find(({ id }) => id === "codex"),
    claudeCode: components.state?.components.find(({ id }) => id === "claude-code"),
    providerKeys: providerKeys.settings?.connections ?? (providerKeys.loadError ? [] : null),
  };
  const rows = firstRunAgentRows(inputs, intl);

  // The order settles once, on the first complete answer, and then holds still under the pointer.
  const [order, setOrder] = useState<readonly string[] | null>(null);
  const settled = firstRunAgentsSettled(inputs, rows);
  if (!order && settled) setOrder(orderFirstRunAgents(rows));

  const run = async (action: NonNullable<FirstRunAgentRow["action"]>) => {
    switch (action.kind) {
      case "codex-sign-in": {
        const login = await codexActions.startChatGptLogin();
        if (login.type === "chatgpt" && login.authUrl) window.open(login.authUrl, "_blank");
        return;
      }
      case "codex-cancel-sign-in":
        if (pendingLogin) await codexActions.cancelLogin(pendingLogin.loginId);
        return;
      case "nodex-sign-in":
        nodexAccount.act("signIn");
        return;
      case "nodex-cancel-sign-in":
        nodexAccount.act("cancelSignIn");
        return;
      case "opencode-install":
        openOpenCodeInstallDialog(appHandle, { owner: openCodeSetupOwner });
        return;
      case "opencode-use":
        await policy.updateSettings(
          (providers.data ?? [])
            .filter((provider) => OPENCODE_DRIVERS.includes(provider.driver))
            .reduce(withFreeModelsOn, policy.settings),
        );
        publishAgentCatalogRefresh();
        return;
      case "local-agent-connect": {
        const found = localAgents.suggestions.find((agent) => agent.id === action.target);
        if (found) await localAgents.connect(found);
        return;
      }
      case "acp-connect":
        if (action.target) acpAgentsOwner.connect(action.target);
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
      case "claude-sign-in":
      case "claude-install":
      case "acp-sign-in":
      case "api-key-add":
        return;
    }
  };

  return {
    rows: arrangeFirstRunAgents(rows, order),
    settled,
    anyReady: rows.some((row) => row.state === "ready"),
    nodexAccount,
    providerKeys,
    acp,
    checkAgain,
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
    useCodexApiKey: async (apiKey: string) => {
      await codexActions.startApiKeyLogin(apiKey);
      await codexAccounts.loadAccount();
      await checkAgain();
    },
  };
}
