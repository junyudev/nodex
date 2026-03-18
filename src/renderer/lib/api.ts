import { resolveInvokeTransport, resolveRendererTransport } from "./renderer-transport";

export async function invoke(
  channel: string,
  ...args: unknown[]
): Promise<unknown> {
  const transport = resolveInvokeTransport(channel);

  if (channel.startsWith("codex:") && transport.kind !== "electron") {
    throw new Error("Codex threads require Electron in this release");
  }

  return transport.invoke(channel, ...args);
}

export function subscribeBoardChanges(
  projectId: string,
  callback: () => void,
): () => void {
  return resolveRendererTransport().subscribeBoardChanges(projectId, callback);
}

export function subscribeCodexEvents(callback: (event: import("./types").CodexEvent) => void): () => void {
  return resolveRendererTransport().subscribeCodexEvents(callback);
}

export function subscribeGitBranchChanges(
  callback: (event: { cwd: string }) => void,
): () => void {
  return resolveRendererTransport().subscribeGitBranchChanges(callback);
}

export function subscribeAppUpdateStatus(
  callback: (status: import("./types").AppUpdateStatus) => void,
): () => void {
  return resolveRendererTransport().subscribeAppUpdateStatus(callback);
}
