import {
  parseBrowserSidebarHostRoutePartition,
  type BrowserSidebarPhysicalHostIdentity,
  type BrowserSidebarTabIdentity,
} from "../../shared/browser-sidebar";
import { isAllowedBrowserNavigationUrl } from "../../shared/browser-url";
import type {
  BrowserAttachmentAuthorizationResult,
  BrowserAuthorizedAttachment,
} from "./browser-runtime-registry";

type BrowserAttachmentAuthorizationFailureReason = Extract<
  BrowserAttachmentAuthorizationResult,
  { ok: false }
>["reason"];

export type BrowserWebviewAttachmentRejectionReason =
  | "invalid-route"
  | "navigation-url-blocked"
  | "storage-identity-mismatch"
  | "window-session-mismatch"
  | `authorization-${BrowserAttachmentAuthorizationFailureReason}`;

export type BrowserWebviewAttachmentDecision =
  | {
      ok: true;
      authorization: BrowserAuthorizedAttachment;
    }
  | {
      ok: false;
      reason: BrowserWebviewAttachmentRejectionReason;
      route: BrowserSidebarPhysicalHostIdentity | null;
    };

interface BrowserWebviewAttachmentPolicyInput {
  authorizeAttachment: (
    route: BrowserSidebarPhysicalHostIdentity,
  ) => BrowserAttachmentAuthorizationResult;
  isRegisteredBrowserStorage: (
    identity: BrowserSidebarTabIdentity,
    browserStorageId: string,
  ) => boolean;
  revokeAuthorizedAttachment: (attachToken: string) => void;
  ownerBrowserViewScopeId: string | null;
  partition: string | null | undefined;
  src: string | null | undefined;
}

export type BrowserWebviewAttachmentInstanceRegistration =
  | { ok: true; instanceId: number }
  | {
      ok: false;
      reason: "duplicate-instance-id" | "invalid-instance-id";
    };

export function registerPendingBrowserWebviewAttachment<Attachment>(
  pendingAttachments: Map<number, Attachment>,
  rawInstanceId: unknown,
  attachment: Attachment,
): BrowserWebviewAttachmentInstanceRegistration {
  const instanceId = parseBrowserWebviewInstanceId(rawInstanceId);
  if (instanceId === null) {
    return { ok: false, reason: "invalid-instance-id" };
  }
  if (pendingAttachments.has(instanceId)) {
    return { ok: false, reason: "duplicate-instance-id" };
  }
  pendingAttachments.set(instanceId, attachment);
  return { ok: true, instanceId };
}

export function consumePendingBrowserWebviewAttachment<Attachment>(
  pendingAttachments: Map<number, Attachment>,
  rawViewInstanceId: unknown,
): Attachment | null {
  const instanceId = parseBrowserWebviewInstanceId(rawViewInstanceId);
  if (instanceId === null) return null;
  const attachment = pendingAttachments.get(instanceId) ?? null;
  pendingAttachments.delete(instanceId);
  return attachment;
}

export function decideBrowserWebviewAttachment(
  input: BrowserWebviewAttachmentPolicyInput,
): BrowserWebviewAttachmentDecision {
  const route = parseBrowserSidebarHostRoutePartition(input.partition);
  if (!route) {
    return { ok: false, reason: "invalid-route", route: null };
  }
  if (input.ownerBrowserViewScopeId !== route.browserViewScopeId) {
    return { ok: false, reason: "window-session-mismatch", route };
  }
  if (!isAllowedBrowserNavigationUrl(input.src)) {
    return { ok: false, reason: "navigation-url-blocked", route };
  }

  const authorization = input.authorizeAttachment(route);
  if (!authorization.ok) {
    return {
      ok: false,
      reason: `authorization-${authorization.reason}`,
      route,
    };
  }
  if (!input.isRegisteredBrowserStorage(route, authorization.authorization.browserStorageId)) {
    input.revokeAuthorizedAttachment(authorization.authorization.attachToken);
    return { ok: false, reason: "storage-identity-mismatch", route };
  }
  return { ok: true, authorization: authorization.authorization };
}

export function parseBrowserWebviewInstanceId(value: unknown): number | null {
  const instanceId = typeof value === "string" && value.trim().length > 0 ? Number(value) : value;
  return typeof instanceId === "number" && Number.isSafeInteger(instanceId) && instanceId > 0
    ? instanceId
    : null;
}
