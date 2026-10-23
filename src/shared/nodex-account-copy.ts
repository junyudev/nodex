import type { NodexAccountErrorCode } from "./nodex-account";

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

/** Uses fixed copy only; credentials and account data never enter the browser response. */
function callbackHtml(state: keyof typeof callbackPages): string {
  const page = callbackPages[state];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>${page.documentTitle}</title><style>${NODEX_ACCOUNT_CALLBACK_CSS}</style></head><body class="${state}"><main><p class="brand">Nodex</p><h1>${page.heading}</h1><p>${page.body}</p></main></body></html>`;
}

export const NODEX_ACCOUNT_CALLBACK_HTML = {
  success: callbackHtml("success"),
  denied: callbackHtml("denied"),
  invalid: callbackHtml("invalid"),
} as const;
