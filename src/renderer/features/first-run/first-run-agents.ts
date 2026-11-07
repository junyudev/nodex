import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toastFailure } from "@/lib/failure-toast";
import { useDefaultCodexAppServerManager } from "@/features/local-conversation/local-conversation-store";
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
import {
  firstRunAgentRows,
  orderFirstRunAgents,
  type FirstRunAgentAction,
  type FirstRunAgentId,
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
  const client = useQueryClient();
  const appHandle = useScopeHandle(appScope);
  const providers = useAgentRuntimeProviders();
  const policy = useModelPolicy();
  const nodexAccount = useNodexAccount(true);
  const nodexView = resolveNodexAccountView(nodexAccount);
  const codexAccounts = useDefaultCodexAppServerManager();
  const codexActions = useCodexAccountActions();
  const codexAccount = useSyncExternalStore(
    (listener) => codexAccounts.subscribeAccount(listener),
    () => codexAccounts.readAccount(),
  );
  const openCodeSetup = useOpenCodeSetup(openCodeSetupOwner, true);
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

  const rows = firstRunAgentRows({
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
  });

  // The order settles once, on the first complete answer, and then holds still under the pointer.
  const [order, setOrder] = useState<readonly FirstRunAgentId[] | null>(null);
  const settled = rows.every((row) => row.state !== "checking");
  if (!order && settled) setOrder(orderFirstRunAgents(rows));
  const rank = (row: FirstRunAgentRow) => order?.indexOf(row.id) ?? 0;

  const run = async (action: FirstRunAgentAction) => {
    switch (action) {
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
      case "claude-sign-in":
      case "claude-install":
        return;
    }
  };

  return {
    rows: rows.toSorted((left, right) => rank(left) - rank(right)),
    settled,
    anyReady: rows.some((row) => row.state === "ready"),
    nodexAccount,
    checkAgain,
    run: (action: FirstRunAgentAction) =>
      run(action).catch((cause: unknown) => toastFailure("Couldn’t connect that Agent", cause)),
    useCodexApiKey: async (apiKey: string) => {
      await codexActions.startApiKeyLogin(apiKey);
      await codexAccounts.loadAccount();
      await checkAgain();
    },
  };
}
