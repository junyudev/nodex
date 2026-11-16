import type { NodexAccountErrorCode } from "./nodex-account";
import type { AppLocale } from "./i18n/locales";
import { defineMessages, type MessageDescriptor } from "./i18n/messages";

export const NODEX_ACCOUNT_ERROR_COPY = {
  "not-configured": {
    message: "Nodex Account isn't available in this build.",
    tone: "error",
  },
  configuration: {
    message: "Sign-in isn't set up correctly in this build of Nodex.",
    tone: "error",
  },
  network: {
    message: "Couldn't reach Nodex Account. Check your connection and try again.",
    tone: "error",
  },
  "oauth-denied": {
    message: "Sign-in was declined in the browser.",
    tone: "error",
  },
  "oauth-invalid-response": {
    message: "Nodex Account sent an unexpected response. Try signing in again.",
    tone: "error",
  },
  "oauth-timeout": {
    message: "Sign-in timed out. Try again.",
    tone: "error",
  },
  "secure-storage": {
    message: "Couldn't access secure storage on this device. Try again.",
    tone: "error",
  },
  "invalid-grant": {
    message: "Your session ended. Sign in again.",
    tone: "error",
  },
  "identity-changed": {
    message: "That's a different account. Sign in with the account shown, or sign out to switch.",
    tone: "error",
  },
  "browser-open": {
    message: "Couldn't open your browser. Check your default browser and try again.",
    tone: "error",
  },
  "revocation-failed": {
    message: "Signed out on this device. Nodex couldn't confirm the server session ended.",
    tone: "warning",
  },
} as const satisfies Record<NodexAccountErrorCode, { message: string; tone: "error" | "warning" }>;

export const NODEX_ACCOUNT_ERROR_MESSAGES = defineMessages({
  "not-configured": {
    id: "shared.nodexAccountCopy.notConfigured",
    defaultMessage: "Nodex Account isn't available in this build.",
  },
  configuration: {
    id: "shared.nodexAccountCopy.configuration",
    defaultMessage: "Sign-in isn't set up correctly in this build of Nodex.",
  },
  network: {
    id: "shared.nodexAccountCopy.network",
    defaultMessage: "Couldn't reach Nodex Account. Check your connection and try again.",
  },
  "oauth-denied": {
    id: "shared.nodexAccountCopy.oauthDenied",
    defaultMessage: "Sign-in was declined in the browser.",
  },
  "oauth-invalid-response": {
    id: "shared.nodexAccountCopy.oauthInvalidResponse",
    defaultMessage: "Nodex Account sent an unexpected response. Try signing in again.",
  },
  "oauth-timeout": {
    id: "shared.nodexAccountCopy.oauthTimeout",
    defaultMessage: "Sign-in timed out. Try again.",
  },
  "secure-storage": {
    id: "shared.nodexAccountCopy.secureStorage",
    defaultMessage: "Couldn't access secure storage on this device. Try again.",
  },
  "invalid-grant": {
    id: "shared.nodexAccountCopy.invalidGrant",
    defaultMessage: "Your session ended. Sign in again.",
  },
  "identity-changed": {
    id: "shared.nodexAccountCopy.identityChanged",
    defaultMessage:
      "That's a different account. Sign in with the account shown, or sign out to switch.",
  },
  "browser-open": {
    id: "shared.nodexAccountCopy.browserOpen",
    defaultMessage: "Couldn't open your browser. Check your default browser and try again.",
  },
  "revocation-failed": {
    id: "shared.nodexAccountCopy.revocationFailed",
    defaultMessage: "Signed out on this device. Nodex couldn't confirm the server session ended.",
  },
} satisfies Record<NodexAccountErrorCode, MessageDescriptor>);

export const NODEX_ACCOUNT_CALLBACK_MESSAGES = defineMessages({
  successTitle: {
    id: "shared.nodexAccountCopy.callbackSuccessTitle",
    defaultMessage: "Nodex · Sign-in response received",
  },
  successHeading: {
    id: "shared.nodexAccountCopy.callbackSuccessHeading",
    defaultMessage: "Sign-in response received",
  },
  successBody: {
    id: "shared.nodexAccountCopy.callbackSuccessBody",
    defaultMessage:
      "Nodex is finishing sign-in. Check the app for the result. You can close this tab.",
  },
  deniedTitle: {
    id: "shared.nodexAccountCopy.callbackDeniedTitle",
    defaultMessage: "Nodex · Sign-in declined",
  },
  deniedHeading: {
    id: "shared.nodexAccountCopy.callbackDeniedHeading",
    defaultMessage: "Sign-in declined",
  },
  deniedBody: {
    id: "shared.nodexAccountCopy.callbackDeniedBody",
    defaultMessage: "Nodex wasn't given access. You can close this tab and try again from Nodex.",
  },
  invalidTitle: {
    id: "shared.nodexAccountCopy.callbackInvalidTitle",
    defaultMessage: "Nodex · Sign-in can't continue",
  },
  invalidHeading: {
    id: "shared.nodexAccountCopy.callbackInvalidHeading",
    defaultMessage: "This sign-in can't continue",
  },
  invalidBody: {
    id: "shared.nodexAccountCopy.callbackInvalidBody",
    defaultMessage:
      "The response is invalid or has expired. Close this tab and start sign-in again from Nodex.",
  },
});

export const NODEX_ACCOUNT_CALLBACK_CSS =
  ':root{color-scheme:light dark;--bg:#f6f5f2;--fg:#1b1a18;--muted:#68655f;--ok:#2e7a4e;--warn:#b0501f}@media(prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe7;--muted:#9b988f;--ok:#62c48a;--warn:#ec9358}}*{margin:0;box-sizing:border-box}body{min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}main{width:100%;max-width:26rem;padding-top:20px;border-top:2px solid var(--accent,var(--muted))}.brand{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}h1{margin-top:12px;font-size:20px;font-weight:600;line-height:1.3;letter-spacing:-.01em}h1+p{margin-top:8px;color:var(--muted)}.success{--accent:var(--ok)}.invalid{--accent:var(--warn)}';

const callbackPages = {
  success: {
    documentTitle: "Nodex · Sign-in response received",
    heading: "Sign-in response received",
    body: "Nodex is finishing sign-in. Check the app for the result. You can close this tab.",
  },
  denied: {
    documentTitle: "Nodex · Sign-in declined",
    heading: "Sign-in declined",
    body: "Nodex wasn't given access. You can close this tab and try again from Nodex.",
  },
  invalid: {
    documentTitle: "Nodex · Sign-in can't continue",
    heading: "This sign-in can't continue",
    body: "The response is invalid or has expired. Close this tab and start sign-in again from Nodex.",
  },
} as const;

export type NodexAccountCallbackState = keyof typeof callbackPages;
type NodexAccountCallbackCopy = Record<keyof (typeof callbackPages)["success"], string>;

function escapeCallbackText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Uses fixed copy only; credentials and account data never enter the browser response. */
function callbackHtml(
  state: NodexAccountCallbackState,
  page: NodexAccountCallbackCopy = callbackPages[state],
  lang: AppLocale | "en" = "en",
): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>${escapeCallbackText(page.documentTitle)}</title><style>${NODEX_ACCOUNT_CALLBACK_CSS}</style></head><body class="${state}"><main><p class="brand">Nodex</p><h1>${escapeCallbackText(page.heading)}</h1><p>${escapeCallbackText(page.body)}</p></main></body></html>`;
}

export function renderNodexAccountCallbackHtml(
  state: NodexAccountCallbackState,
  locale: AppLocale,
  formatMessage: (message: MessageDescriptor) => string,
): string {
  const messages = NODEX_ACCOUNT_CALLBACK_MESSAGES;
  return callbackHtml(
    state,
    {
      documentTitle: formatMessage(messages[`${state}Title`]),
      heading: formatMessage(messages[`${state}Heading`]),
      body: formatMessage(messages[`${state}Body`]),
    },
    locale === "en-US" ? "en" : locale,
  );
}

export const NODEX_ACCOUNT_CALLBACK_HTML = {
  success: callbackHtml("success"),
  denied: callbackHtml("denied"),
  invalid: callbackHtml("invalid"),
} as const;
