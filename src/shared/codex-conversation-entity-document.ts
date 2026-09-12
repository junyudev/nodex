import { enablePatches, produceWithPatches, type Draft, type Patch } from "immer";
import type {
  CodexCanonicalConversationState,
  CodexCanonicalServerRequest,
} from "./codex-conversation-state/codex-conversation-state";

enablePatches();

export interface CodexConversationDocumentMutation<TResult> {
  readonly document: CodexConversationEntityDocument;
  readonly before: CodexCanonicalConversationState;
  readonly after: CodexCanonicalConversationState;
  readonly patches: readonly Patch[];
  readonly result: TResult;
}

type EntityDocumentState =
  | { readonly kind: "conversation"; readonly conversation: CodexCanonicalConversationState }
  | {
      readonly kind: "unmaterialized";
      readonly requests: readonly CodexCanonicalServerRequest[];
      readonly hasUnreadTurn: boolean;
    };

/** One canonical document; requests can arrive before a conversation has been materialized. */
export class CodexConversationEntityDocument {
  constructor(
    private readonly state: EntityDocumentState = {
      kind: "unmaterialized",
      requests: [],
      hasUnreadTurn: false,
    },
    private readonly mutation: {readonly before: CodexCanonicalConversationState; readonly patches: readonly Patch[]} | null = null,
  ) {}

  get canonicalState(): CodexCanonicalConversationState | null {
    return this.state.kind === "conversation" ? this.state.conversation : null;
  }

  get requests(): readonly CodexCanonicalServerRequest[] {
    return this.state.kind === "conversation"
      ? this.state.conversation.requests
      : this.state.requests;
  }

  get hasUnreadTurn(): boolean {
    return this.state.kind === "conversation"
      ? this.state.conversation.hasUnreadTurn
      : this.state.hasUnreadTurn;
  }

  /** Records the recipe's actual writes, including stable history entity paths. */
  mutate<TResult>(
    recipe: (draft: Draft<CodexCanonicalConversationState>) => TResult,
  ): CodexConversationDocumentMutation<TResult> | null {
    const before = this.canonicalState;
    if (!before) return null;
    let result!: TResult;
    const [after, patches] = produceWithPatches(before, (draft) => {
      result = recipe(draft);
    });
    const document = after === before ? this : new CodexConversationEntityDocument({kind: "conversation", conversation: after}, {before, patches});
    return { document, before, after, patches, result };
  }

  patchesFrom(before: CodexCanonicalConversationState | null): readonly Patch[] | undefined {
    return this.mutation?.before === before ? this.mutation.patches : undefined;
  }

  withCanonicalState(
    state: CodexCanonicalConversationState | null,
  ): CodexConversationEntityDocument {
    if (state === this.canonicalState) {
      if (state !== null || (this.requests.length === 0 && !this.hasUnreadTurn)) return this;
    }
    if (state === null) return new CodexConversationEntityDocument();
    return new CodexConversationEntityDocument({ kind: "conversation", conversation: state });
  }

  withRequests(requests: readonly CodexCanonicalServerRequest[]): CodexConversationEntityDocument {
    if (requests === this.requests) return this;
    if (this.state.kind === "conversation") {
      return this.withCanonicalState({ ...this.state.conversation, requests });
    }
    return new CodexConversationEntityDocument({ ...this.state, requests });
  }

  withUnreadState(hasUnreadTurn: boolean): CodexConversationEntityDocument {
    if (hasUnreadTurn === this.hasUnreadTurn) return this;
    if (this.state.kind === "conversation") {
      return this.withCanonicalState({ ...this.state.conversation, hasUnreadTurn });
    }
    return new CodexConversationEntityDocument({ ...this.state, hasUnreadTurn });
  }
}
