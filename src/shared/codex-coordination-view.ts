import { RpcTarget } from "capnweb";
import type {
  ConversationCoordinationEvent,
  ConversationCoordinationParams,
  ConversationCoordinationView,
  ConversationFollowerRequest,
} from "./codex-client-coordination";

export type ConversationCoordinationBroadcast = Exclude<
  keyof ConversationCoordinationView,
  "getThreadRole" | "requestThreadFollower"
>;

export interface ConversationCoordinationManager {
  getStreamRole(
    conversationId: string,
  ): { role: "owner" | "follower" } | null | Promise<{ role: "owner" | "follower" } | null>;
  handleThreadFollowerRequest(request: ConversationFollowerRequest): Promise<{
    method: string;
    result: unknown;
  }>;
}

/** The window service resolves a host's manager at call time, including during window startup. */
export class ConversationCoordinationViewTarget
  extends RpcTarget
  implements ConversationCoordinationView
{
  constructor(
    private readonly getManager: (hostId: string) => ConversationCoordinationManager,
    private readonly broadcast: (
      method: ConversationCoordinationBroadcast,
      event: ConversationCoordinationEvent,
    ) => void,
  ) {
    super();
  }

  threadArchived(event: ConversationCoordinationEvent): void {
    this.broadcast("threadArchived", event);
  }

  threadUnarchived(event: ConversationCoordinationEvent): void {
    this.broadcast("threadUnarchived", event);
  }

  threadQueuedFollowUpsChanged(event: ConversationCoordinationEvent): void {
    this.broadcast("threadQueuedFollowUpsChanged", event);
  }

  clientStatusChanged(event: ConversationCoordinationEvent): void {
    this.broadcast("clientStatusChanged", event);
  }

  ipcConnectionReset(event: ConversationCoordinationEvent): void {
    this.broadcast("ipcConnectionReset", event);
  }

  threadStreamStateChanged(event: ConversationCoordinationEvent): void {
    this.broadcast("threadStreamStateChanged", event);
  }

  threadStreamFollowingChanged(event: ConversationCoordinationEvent): void {
    this.broadcast("threadStreamFollowingChanged", event);
  }

  threadStreamFollowingStatusRequested(event: ConversationCoordinationEvent): void {
    this.broadcast("threadStreamFollowingStatusRequested", event);
  }

  async getThreadRole({
    hostId,
    conversationId,
  }: ConversationCoordinationParams): Promise<"owner" | "follower"> {
    return (await this.getManager(hostId).getStreamRole(conversationId))?.role === "owner"
      ? "owner"
      : "follower";
  }

  async requestThreadFollower({
    hostId,
    request,
  }: {
    hostId: string;
    request: ConversationFollowerRequest;
  }): Promise<{ method: string; result: unknown }> {
    return this.getManager(hostId).handleThreadFollowerRequest(request);
  }
}
