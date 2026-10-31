import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export interface SessionQuestionTarget {
  readonly sessionId: string;
  readonly execution?: { readonly threadId: string };
}
export interface SessionQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: readonly {
    readonly label: string;
    readonly description?: string | undefined;
  }[];
  readonly multiSelect?: boolean | undefined;
  readonly allowCustomAnswer?: boolean | undefined;
  readonly isSecret?: boolean | undefined;
  readonly required?: boolean | undefined;
}
export type SessionQuestionAnswers = Record<string, string | readonly string[]>;
export interface SessionQuestionResponder {
  readonly kind: "agent";
  readonly senderThreadId: string;
  readonly senderSessionId: string | null;
}
export class SessionQuestionError extends Schema.TaggedError<SessionQuestionError>()(
  "SessionQuestionError",
  {
    code: Schema.Literals(["not_found", "not_pending", "unsupported", "forbidden", "unavailable"]),
    message: Schema.String,
  },
) {}
export interface SessionQuestionBackend {
  readonly list: (
    target: SessionQuestionTarget,
  ) => Effect.Effect<{ readonly requestIds: readonly string[] }, SessionQuestionError>;
  readonly read: (
    target: SessionQuestionTarget,
    requestId: string,
  ) => Effect.Effect<
    { readonly requestId: string; readonly questions: readonly SessionQuestion[] },
    SessionQuestionError
  >;
  readonly respond: (
    target: SessionQuestionTarget,
    requestId: string,
    answers: SessionQuestionAnswers,
    responder: SessionQuestionResponder,
    operationId: string,
  ) => Effect.Effect<
    { readonly requestId: string; readonly status: "answered" },
    SessionQuestionError
  >;
}
