import type { ThreadReadStateRpcService } from "./codex-thread-read-state";
import { RpcTarget } from "capnweb";
import type { CodexTranscriptReadRpcService } from "./codex-transcript-read-service";

/** Services are exported below the root capability so both directions have the same RPC shape. */
export class ConversationServiceRoot<Coordination> extends RpcTarget {
  constructor(
    private readonly coordination: Coordination,
    private readonly readState?: ThreadReadStateRpcService,
    private readonly transcriptRead?: CodexTranscriptReadRpcService,
  ) {
    super();
  }

  get services(): {
    clientCoordination: Coordination;
    threadReadState?: ThreadReadStateRpcService;
    transcriptRead?: CodexTranscriptReadRpcService;
  } {
    return {
      clientCoordination: this.coordination,
      ...(this.readState ? { threadReadState: this.readState } : {}),
      ...(this.transcriptRead ? { transcriptRead: this.transcriptRead } : {}),
    };
  }
}
