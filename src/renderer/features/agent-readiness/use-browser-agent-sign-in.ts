import { useEffect, useEffectEvent, useSyncExternalStore } from "react";
import { codexAgent } from "../../../shared/agents/codex";
import { useCodexAccountActions } from "@/lib/use-codex-account-actions";
import { useDefaultCodexAppServerManager } from "../local-conversation/local-conversation-store";

/** The native browser sign-in owner. Completion refreshes the Agent catalog. */
export function useBrowserAgentSignIn(onSignedIn: () => void, observe = true) {
  const manager = useDefaultCodexAppServerManager();
  const actions = useCodexAccountActions();
  const signedIn = useEffectEvent(onSignedIn);
  useEffect(() => {
    if (!observe) return;
    let previous = Boolean(manager.readAccount()?.account);
    return manager.subscribeAccount(() => {
      const current = Boolean(manager.readAccount()?.account);
      if (current && !previous) signedIn();
      previous = current;
    });
  }, [manager, observe]);
  return {
    manager,
    actions,
    owner: codexAgent.setup.signIn.owner,
    begin: async () => {
      const login = await actions.startChatGptLogin();
      if (login.type === "chatgpt" && login.authUrl) window.open(login.authUrl, "_blank");
    },
  };
}

/** First-run also owns the pending browser action and offers the account's API-key form. */
export function useFirstRunBrowserSignIn(onSignedIn: () => void) {
  const { manager, actions, owner, begin } = useBrowserAgentSignIn(onSignedIn, false);
  const signedIn = useEffectEvent(onSignedIn);
  const snapshot = useSyncExternalStore(
    (listener) => manager.subscribeAccount(listener),
    () => manager.readAccount(),
  );
  useEffect(() => {
    void manager.loadAccount().catch(() => undefined);
  }, [manager]);
  const hasAccount = Boolean(snapshot?.account);
  useEffect(() => {
    if (hasAccount) signedIn();
  }, [hasAccount]);
  const pending = snapshot?.pendingLogin;
  return {
    owner,
    pending: pending ? owner : null,
    begin,
    cancel: () => pending && actions.cancelLogin(pending.loginId),
    submitKey: async (apiKey: string) => {
      await actions.startApiKeyLogin(apiKey);
      await manager.loadAccount();
    },
  };
}
