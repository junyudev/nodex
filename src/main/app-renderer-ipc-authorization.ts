import { APP_RENDERER_HOST, APP_RENDERER_PROTOCOL_SCHEME } from "../shared/app-renderer-policy";

export interface AppRendererIpcSenderFacts {
  readonly developmentOrigin?: string | null;
  readonly hasOwnerWindow: boolean;
  readonly senderType: string;
  readonly senderUrl: string;
  readonly isMainFrame: boolean;
}

export function hasTrustedAppRendererOrigin(
  senderUrl: string,
  developmentOrigin: string | null | undefined,
): boolean {
  try {
    const sender = new URL(senderUrl);
    if (
      sender.protocol === `${APP_RENDERER_PROTOCOL_SCHEME}:` &&
      sender.hostname === APP_RENDERER_HOST &&
      !sender.port &&
      !sender.username &&
      !sender.password
    ) {
      return true;
    }
    if (!developmentOrigin) return false;
    const expected = new URL(developmentOrigin);
    return (
      (sender.protocol === "http:" || sender.protocol === "https:") &&
      sender.origin === expected.origin
    );
  } catch {
    return false;
  }
}

export function isTrustedAppRendererIpcSender(facts: AppRendererIpcSenderFacts): boolean {
  return (
    facts.hasOwnerWindow &&
    facts.senderType === "window" &&
    facts.isMainFrame &&
    hasTrustedAppRendererOrigin(facts.senderUrl, facts.developmentOrigin)
  );
}
