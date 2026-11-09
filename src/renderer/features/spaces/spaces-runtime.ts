import { SpaceNotificationActionSchema } from "../../../shared/schemas/desktop-notification";
import type { DesktopNotificationActionInvocation } from "../../../shared/types";
import { useEffect } from "react";
import {
  QueryObserver,
  queryOptions,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererQuery,
} from "@/lib/renderer-command";
import { resolveRendererTransport } from "@/lib/renderer-transport";
import { flushForSpaceSwitch } from "@/lib/app-close-flush";
import { rendererSpace } from "@/lib/renderer-space";
import type { ResolvedSpaceDeepLink } from "../../../shared/nodex-deeplink";
import type { JoinSpaceInput, SpaceConnectionSummary } from "../../../shared/space-connection";

const joinCommand = defineRendererCommand({
  key: "spaces.join",
  channel: "spaces:join",
  authority: "main",
  owner: "SpaceConnections",
  protocol: { kind: "returned_value" },
});
const leaveCommand = defineRendererCommand({
  key: "spaces.leave",
  channel: "spaces:leave",
  authority: "main",
  owner: "SpaceConnections",
  protocol: { kind: "pending_operation" },
});
const switchCommand = defineRendererCommand({
  key: "spaces.switch",
  channel: "spaces:switch",
  authority: "main",
  owner: "SpaceConnections",
  protocol: { kind: "returned_value" },
});
const spaceConnections = queryOptions({
  queryKey: ["desktop", "space-connections"] as const,
  queryFn: () => invokeRendererQuery("spaces:list"),
  staleTime: Infinity,
});

export const useSpaceConnections = () => useQuery(spaceConnections);

/**
 * Follows this document's Space connections; mounted once. Every read here belongs to the
 * document's Space, so when that Space is ready again after being away, all of them are read
 * again: those that failed while its host was down and those that missed its changes alike.
 */
export function followSpaceConnections(client: QueryClient): () => void {
  const { spaceId, availability } = rendererSpace();
  const availabilityIn = (spaces: readonly SpaceConnectionSummary[] | undefined) =>
    spaces?.find((space) => space.spaceId === spaceId)?.availability;
  let ready =
    (availabilityIn(client.getQueryData(spaceConnections.queryKey)) ?? availability) === "ready";
  const connections = new QueryObserver(client, spaceConnections);
  const stopObserving = connections.subscribe(({ data }) => {
    const current = availabilityIn(data);
    if (current === undefined) return;
    const returned = current === "ready" && !ready;
    ready = current === "ready";
    if (returned)
      void client.invalidateQueries({
        predicate: (query) => query.queryHash !== connections.getCurrentQuery().queryHash,
      });
  });
  const stopFollowing = resolveRendererTransport().subscribeSpaceConnections?.((spaces) => {
    client.setQueryData(spaceConnections.queryKey, spaces);
  });
  return () => {
    stopObserving();
    stopFollowing?.();
  };
}

export function useFollowSpaceConnections(): void {
  const client = useQueryClient();
  useEffect(() => followSpaceConnections(client), [client]);
}

/**
 * Every connected Space and this window's own. Identity stays document-bound; host-owned names
 * and availability follow connection refreshes.
 */
export function useSpaces(): {
  readonly spaces: readonly SpaceConnectionSummary[];
  readonly current: SpaceConnectionSummary;
} {
  const bound = rendererSpace();
  const spaces = useSpaceConnections().data ?? [bound];
  return {
    spaces,
    current: spaces.find((space) => space.spaceId === bound.spaceId) ?? bound,
  };
}

export const useCurrentSpace = (): SpaceConnectionSummary => useSpaces().current;

export const joinSpace = (input: JoinSpaceInput) => invokePlainCommand(joinCommand, input);
export const leaveSpace = (spaceId: string) => invokePlainCommand(leaveCommand, spaceId);
export async function switchSpace(spaceId: string, target?: ResolvedSpaceDeepLink): Promise<void> {
  if (spaceId === rendererSpace().spaceId) return;
  await flushForSpaceSwitch();
  const url = new URL(await invokePlainCommand(switchCommand, spaceId));
  url.searchParams.delete("spaceLink");
  if (target) url.searchParams.set("spaceLink", JSON.stringify({ ...target, spaceId }));
  window.location.assign(url.toString());
}

export { rendererSpace as currentSpace };

const openLinkCommand = defineRendererCommand({
  key: "spaces.open_link",
  channel: "spaces:open-link",
  authority: "main",
  owner: "SpaceConnections",
  protocol: { kind: "returned_value" },
});
export const openSpaceLink = (url: string) => invokePlainCommand(openLinkCommand, url);

const notificationKey = (spaceId: string, nonce: string) =>
  JSON.stringify(["space", spaceId, null, "notification", nonce]);
export async function switchSpaceForNotification(
  invocation: DesktopNotificationActionInvocation & { readonly spaceId: string },
): Promise<void> {
  const validated = SpaceNotificationActionSchema.parse(invocation);
  const nonce = crypto.randomUUID();
  const key = notificationKey(validated.spaceId, nonce);
  await flushForSpaceSwitch();
  const url = new URL(await invokePlainCommand(switchCommand, validated.spaceId));
  sessionStorage.setItem(key, JSON.stringify(validated));
  url.searchParams.set("spaceNotification", nonce);
  window.location.assign(url.toString());
}

export function takeSpaceNotification(): DesktopNotificationActionInvocation | null {
  const url = new URL(window.location.href);
  const nonce = url.searchParams.get("spaceNotification");
  if (!nonce) return null;
  url.searchParams.delete("spaceNotification");
  window.history.replaceState(null, "", url);
  const key = notificationKey(rendererSpace().spaceId, nonce);
  const stored = sessionStorage.getItem(key);
  sessionStorage.removeItem(key);
  if (!stored) return null;
  try {
    const value = SpaceNotificationActionSchema.parse(JSON.parse(stored));
    return value.spaceId === rendererSpace().spaceId ? value : null;
  } catch {
    return null;
  }
}
