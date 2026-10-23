import { queryOptions } from "@tanstack/react-query";
import { NodexAccountSnapshotSchema, type NodexAccountSnapshot } from "../../shared/nodex-account";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const signInCommand = defineRendererCommand({
  key: "nodex_account.sign_in",
  channel: "nodex-account:sign-in",
  authority: "main",
  owner: "NodexAccount",
  protocol: { kind: "returned_value" },
});
const cancelSignInCommand = defineRendererCommand({
  key: "nodex_account.cancel_sign_in",
  channel: "nodex-account:cancel-sign-in",
  authority: "main",
  owner: "NodexAccount",
  protocol: { kind: "returned_value" },
});
const signOutCommand = defineRendererCommand({
  key: "nodex_account.sign_out",
  channel: "nodex-account:sign-out",
  authority: "main",
  owner: "NodexAccount",
  protocol: { kind: "returned_value" },
});
const refreshCommand = defineRendererCommand({
  key: "nodex_account.refresh",
  channel: "nodex-account:refresh",
  authority: "main",
  owner: "NodexAccount",
  protocol: { kind: "returned_value" },
});

export const nodexAccountQueryKey = ["nodexAccount"] as const;

/** Read and command replies share the same revision fence as Main's broadcasts. */
export function selectNodexAccountSnapshot(
  current: NodexAccountSnapshot | undefined,
  next: NodexAccountSnapshot,
): NodexAccountSnapshot {
  if (current && current.revision >= next.revision) return current;
  return next;
}

export const nodexAccountQueryOptions = queryOptions({
  queryKey: nodexAccountQueryKey,
  queryFn: async ({ client }) => {
    const revision =
      client.getQueryData<NodexAccountSnapshot>(nodexAccountQueryKey)?.revision ?? -1;
    try {
      return await invokeRendererQuery("nodex-account:read");
    } catch (error) {
      const current = client.getQueryData<NodexAccountSnapshot>(nodexAccountQueryKey);
      if (current && current.revision > revision) return current;
      throw error;
    }
  },
  networkMode: "always",
  refetchOnWindowFocus: false,
  retry: false,
  structuralSharing: (current, next) =>
    selectNodexAccountSnapshot(
      current as NodexAccountSnapshot | undefined,
      next as NodexAccountSnapshot,
    ),
});

export const nodexAccountActions = {
  signIn: () => invokePlainCommand(signInCommand),
  cancelSignIn: () => invokePlainCommand(cancelSignInCommand),
  signOut: () => invokePlainCommand(signOutCommand),
  refresh: () => invokePlainCommand(refreshCommand),
};

export type NodexAccountAction = keyof typeof nodexAccountActions;

export function subscribeNodexAccountChanges(
  listener: (snapshot: NodexAccountSnapshot) => void,
): () => void {
  if (!window.api) return () => undefined;
  return window.api.on("nodex-account:changed", (value) => {
    const parsed = NodexAccountSnapshotSchema.safeParse(value);
    if (parsed.success) listener(parsed.data);
  });
}
