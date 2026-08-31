import {
  RENDERER_DELIVERY_ACK_CHANNEL,
  RENDERER_DELIVERY_DATA_CHANNEL,
  advanceRendererDeliveryAssembler,
  createRendererDeliveryAssemblerState,
  parseRendererDeliveryEnvelope,
  type RendererDeliveryRoutedPayload,
  type RendererDeliveryTransferAckEnvelope,
} from "./renderer-delivery-transport";

export type RendererDeliveryPreloadListener = (...args: readonly unknown[]) => void;

export interface RendererDeliveryPreloadBridgeOptions {
  readonly acknowledge: (acknowledgment: RendererDeliveryTransferAckEnvelope) => void;
  readonly reportError: (message: string, cause: unknown) => void;
}

const readRoutedPayload = (input: unknown): RendererDeliveryRoutedPayload | null => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Readonly<Record<string, unknown>>;
  if (Object.keys(record).length !== 2) return null;
  if (typeof record.channel !== "string" || record.channel.length === 0) return null;
  if (!Array.isArray(record.args)) return null;
  if (
    record.channel === RENDERER_DELIVERY_DATA_CHANNEL ||
    record.channel === RENDERER_DELIVERY_ACK_CHANNEL
  ) {
    return null;
  }
  return { channel: record.channel, args: record.args } as RendererDeliveryRoutedPayload;
};

/**
 * Reassembles Main-owned bounded deliveries before replaying their original IPC
 * channel. One preload instance owns one generation-fenced assembler and has no
 * queue of its own; Main's RendererDelivery lane remains the sole FIFO owner.
 */
export const createRendererDeliveryPreloadBridge = (
  options: RendererDeliveryPreloadBridgeOptions,
) => {
  const listeners = new Map<string, Set<RendererDeliveryPreloadListener>>();
  let assembler = createRendererDeliveryAssemblerState();
  let target: { readonly targetId: string; readonly generation: number } | null = null;

  const subscribe = (channel: string, listener: RendererDeliveryPreloadListener): (() => void) => {
    const channelListeners = listeners.get(channel) ?? new Set();
    channelListeners.add(listener);
    listeners.set(channel, channelListeners);
    return () => {
      channelListeners.delete(listener);
      if (channelListeners.size === 0) listeners.delete(channel);
    };
  };

  const receive = (input: unknown): void => {
    try {
      const envelope = parseRendererDeliveryEnvelope(input);
      if (target && envelope.generation < target.generation) return;
      if (
        target &&
        envelope.generation === target.generation &&
        envelope.targetId !== target.targetId
      ) {
        return;
      }
      if (!target || envelope.generation > target.generation) {
        assembler = createRendererDeliveryAssemblerState();
        target = { targetId: envelope.targetId, generation: envelope.generation };
      }

      const transition = advanceRendererDeliveryAssembler(assembler, envelope);
      assembler = transition.state;
      if (transition.kind === "aborted") return;
      if (transition.kind === "complete") {
        const routed = readRoutedPayload(transition.delivery.payload);
        if (!routed) throw new Error("Renderer delivery contained an invalid routed payload");
        for (const listener of listeners.get(routed.channel) ?? []) {
          try {
            listener(...routed.args);
          } catch (cause) {
            options.reportError(`Renderer delivery listener failed for ${routed.channel}`, cause);
          }
        }
      }
      if (transition.acknowledgment) options.acknowledge(transition.acknowledgment);
    } catch (cause) {
      options.reportError("Rejected invalid renderer delivery", cause);
    }
  };

  return { receive, subscribe } as const;
};
