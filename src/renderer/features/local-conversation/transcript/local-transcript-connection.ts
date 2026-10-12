import { newMessagePortRpcSession, type RpcStub } from "capnweb";
import { ConversationServiceRoot } from "../../../../shared/codex-service-root";
import type { CodexTranscriptEvent } from "../../../../shared/codex-transcript-projection";
import type { CodexTranscriptReadService } from "../../../../shared/codex-transcript-read-service";
import type { CodexHistoryViewportBoundary } from "../../../../shared/codex-history-policy";

export type LocalTranscriptConnection = (() => void) & {
  setHistoryViewport(boundaries: readonly (CodexHistoryViewportBoundary | null)[]): void;
};
type RemoteTranscriptService = NonNullable<
  Awaited<RpcStub<ConversationServiceRoot<undefined>>["services"]>["transcriptRead"]
>;
type RemoteTranscriptSubscription = Awaited<ReturnType<RemoteTranscriptService["subscribe"]>>;

/** Local and hosted read capabilities use the same RPC callback completion contract. */
export function connectLocalTranscript(
  service: CodexTranscriptReadService,
  threadId: string,
  listener: (event: CodexTranscriptEvent) => Promise<void>,
): LocalTranscriptConnection {
  const { port1, port2 } = new MessageChannel();
  const server = newMessagePortRpcSession(
    port1,
    new ConversationServiceRoot(undefined, undefined, service),
  );
  const client = newMessagePortRpcSession<ConversationServiceRoot<undefined>>(port2);
  let alive = true;
  let subscription: RemoteTranscriptSubscription | undefined;
  let viewports: readonly (CodexHistoryViewportBoundary | null)[] = [null];
  const release = () => {
    if (!alive) return;
    alive = false;
    if (subscription) {
      void subscription.unsubscribe().catch(() => {});
      subscription[Symbol.dispose]();
      subscription = undefined;
    }
    client[Symbol.dispose]();
    server[Symbol.dispose]();
    port1.close();
    port2.close();
  };
  void (async () => {
    const services = await client.services;
    if (!alive || !services.transcriptRead) return;
    const opened = await services.transcriptRead.subscribe(threadId, (event) =>
      alive ? listener(event) : Promise.resolve(),
    );
    if (!alive) {
      void opened.unsubscribe().catch(() => {});
      opened[Symbol.dispose]();
      return;
    }
    subscription = opened;
    void subscription.setHistoryViewport(viewports).catch(release);
  })().catch(release);
  return Object.assign(release, {
    setHistoryViewport: (boundaries: readonly (CodexHistoryViewportBoundary | null)[]) => {
      viewports = boundaries;
      if (alive && subscription) void subscription.setHistoryViewport(boundaries).catch(release);
    },
  });
}
