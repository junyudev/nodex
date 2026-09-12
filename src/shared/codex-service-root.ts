import type { ThreadReadStateRpcService } from "./codex-thread-read-state";
import { RpcTarget } from "capnweb";

/** Services are exported below the root capability so both directions have the same RPC shape. */
export class ConversationServiceRoot<Coordination> extends RpcTarget {
  constructor(
    private readonly coordination: Coordination,
    private readonly readState?: ThreadReadStateRpcService,
  ) {
    super();
  }

  get services(): {
    clientCoordination: Coordination;
    threadReadState?: ThreadReadStateRpcService;
  } {
    return {
      clientCoordination: this.coordination,
      ...(this.readState ? { threadReadState: this.readState } : {}),
    };
  }
}
