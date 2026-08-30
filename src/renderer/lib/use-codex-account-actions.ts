import { useCallback, useMemo } from "react";
import type { CodexRateLimitResetInput } from "./types";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const consumeRateLimitResetCommand = defineRendererCommand({
  key: "codex.account.consume_rate_limit_reset",
  channel: "codex:account:rate-limit-reset:consume",
  authority: "external",
  owner: "CodexAccountActions",
  protocol: { kind: "returned_value" },
});

const startLoginCommand = defineRendererCommand({
  key: "codex.account.start_login",
  channel: "codex:account:login:start",
  authority: "external",
  owner: "CodexAccountActions",
  protocol: { kind: "pending_operation" },
});

const cancelLoginCommand = defineRendererCommand({
  key: "codex.account.cancel_login",
  channel: "codex:account:login:cancel",
  authority: "external",
  owner: "CodexAccountActions",
  protocol: { kind: "pending_operation" },
});

const logoutCommand = defineRendererCommand({
  key: "codex.account.logout",
  channel: "codex:account:logout",
  authority: "external",
  owner: "CodexAccountActions",
  protocol: { kind: "returned_value" },
});

export function useCodexAccountActions() {
  const refreshAccount = useCallback(async () => {
    return invokeRendererQuery("codex:account:read");
  }, []);

  const consumeRateLimitReset = useCallback(async (input: CodexRateLimitResetInput) => {
    return invokePlainCommand(consumeRateLimitResetCommand, input);
  }, []);

  const startChatGptLogin = useCallback(async () => {
    return invokePlainCommand(startLoginCommand, { type: "chatgpt" });
  }, []);

  const startApiKeyLogin = useCallback(async (apiKey: string) => {
    return invokePlainCommand(startLoginCommand, { type: "apiKey", apiKey });
  }, []);

  const cancelLogin = useCallback(async (loginId: string) => {
    return invokePlainCommand(cancelLoginCommand, loginId);
  }, []);

  const logout = useCallback(async () => {
    return invokePlainCommand(logoutCommand);
  }, []);

  return useMemo(
    () => ({
      refreshAccount,
      consumeRateLimitReset,
      startChatGptLogin,
      startApiKeyLogin,
      cancelLogin,
      logout,
    }),
    [
      cancelLogin,
      consumeRateLimitReset,
      logout,
      refreshAccount,
      startApiKeyLogin,
      startChatGptLogin,
    ],
  );
}
