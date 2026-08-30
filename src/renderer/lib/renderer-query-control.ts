import type { IpcApi } from "../../shared/ipc-api";
import type { IpcControlChannel, IpcQueryChannel } from "../../shared/ipc-endpoint-policy";

export interface RendererQueryControlPort {
  readonly invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
}

type IpcArgs<Channel extends keyof IpcApi> = IpcApi[Channel]["args"] extends readonly unknown[]
  ? IpcApi[Channel]["args"]
  : never;

/** Lightweight typed transport for bootstrap and other pre-command-runtime queries. */
export function invokeRendererQueryThrough<Channel extends IpcQueryChannel>(
  transport: RendererQueryControlPort,
  channel: Channel,
  ...args: IpcArgs<Channel>
): Promise<IpcApi[Channel]["result"]> {
  return transport.invoke(channel, ...args) as Promise<IpcApi[Channel]["result"]>;
}

/** Lightweight typed transport for bootstrap and other pre-command-runtime controls. */
export function invokeRendererControlThrough<Channel extends IpcControlChannel>(
  transport: RendererQueryControlPort,
  channel: Channel,
  ...args: IpcArgs<Channel>
): Promise<IpcApi[Channel]["result"]> {
  return transport.invoke(channel, ...args) as Promise<IpcApi[Channel]["result"]>;
}
