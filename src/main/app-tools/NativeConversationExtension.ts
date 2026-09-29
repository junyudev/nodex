import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { AgentBackendBinding } from "../../shared/agent-backend";
import type { CodexScheduledAutomation } from "../../shared/types";

export interface NativeConversationState {
  readonly threadId: string;
  readonly backendBinding: AgentBackendBinding;
  readonly busy: boolean;
  readonly archived: boolean;
  readonly updatedAt: number;
  readonly title: string;
}

export interface NativeTurnOutcome {
  readonly turnId: string;
  readonly outcome: "completed" | "failed" | "interrupted";
  readonly assistantText: string;
}

/** Supplied by the application composition root; tools never import their application owner. */
export class NativeConversationExtension extends Context.Service<
  NativeConversationExtension,
  {
    readonly read: (threadId: string) => Effect.Effect<NativeConversationState | null, Error>;
    readonly submit: (input: {
      readonly threadId: string;
      readonly prompt: string;
      readonly operationId: string;
      readonly model?: string;
      readonly effort?: string;
      /** Interactive approvals must be denied rather than left pending in unattended execution. */
      readonly unattended?: boolean;
    }) => Effect.Effect<{ readonly turnId: string }, Error>;
    readonly wait: (threadId: string, turnId: string) => Effect.Effect<NativeTurnOutcome, Error>;
    readonly cancel: (threadId: string, turnId: string) => Effect.Effect<void, Error>;
    readonly createAutomationSession: (input: {
      readonly definition: CodexScheduledAutomation;
      readonly cwd: string | null;
      readonly operationId: string;
    }) => Effect.Effect<{ readonly threadId: string }, Error>;
    readonly validateAutomation: (
      definition: Pick<
        CodexScheduledAutomation,
        | "backendBinding"
        | "model"
        | "reasoningEffort"
        | "serviceTier"
        | "executionEnvironment"
        | "localEnvironmentConfigPath"
      >,
    ) => Effect.Effect<void, Error>;
  }
>()("nodex/main/app-tools/NativeConversationExtension") {}

export class NativeConversationBindingError extends Schema.TaggedError<NativeConversationBindingError>()(
  "NativeConversationBindingError",
  { reason: Schema.Literals(["closed", "already_bound"]) },
) {}

export class NativeConversationBinding extends Context.Service<
  NativeConversationBinding,
  {
    readonly bind: (
      service: NativeConversationExtension["Service"],
    ) => Effect.Effect<void, NativeConversationBindingError>;
  }
>()("nodex/main/app-tools/NativeConversationBinding") {}

/** Breaks construction cycles without publishing a partially initialized application owner. */
export const makeBinding = Effect.gen(function* () {
  const ready = yield* Deferred.make<NativeConversationExtension["Service"]>();
  const closed = yield* Deferred.make<never, NativeConversationBindingError>();
  let open = true;
  let bound = false;
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      open = false;
      yield* Deferred.fail(closed, new NativeConversationBindingError({ reason: "closed" }));
    }),
  );
  const invoke = <A>(
    use: (service: NativeConversationExtension["Service"]) => Effect.Effect<A, Error>,
  ): Effect.Effect<A, Error> =>
    Effect.suspend(() => {
      if (!open) return new NativeConversationBindingError({ reason: "closed" });
      return Deferred.await(ready).pipe(
        Effect.flatMap((service) =>
          open ? use(service) : new NativeConversationBindingError({ reason: "closed" }),
        ),
        Effect.raceFirst(Deferred.await(closed)),
      );
    });
  const extension = NativeConversationExtension.of({
    read: (threadId) => invoke((service) => service.read(threadId)),
    submit: (input) => invoke((service) => service.submit(input)),
    wait: (threadId, turnId) => invoke((service) => service.wait(threadId, turnId)),
    cancel: (threadId, turnId) => invoke((service) => service.cancel(threadId, turnId)),
    createAutomationSession: (input) => invoke((service) => service.createAutomationSession(input)),
    validateAutomation: (definition) => invoke((service) => service.validateAutomation(definition)),
  });
  const binding = NativeConversationBinding.of({
    bind: (service) =>
      Effect.gen(function* () {
        if (!open) return yield* new NativeConversationBindingError({ reason: "closed" });
        if (bound) return yield* new NativeConversationBindingError({ reason: "already_bound" });
        bound = true;
        yield* Deferred.succeed(ready, service);
      }),
  });
  return { extension, binding };
});

export const bindingLayer = Layer.effectContext(
  makeBinding.pipe(
    Effect.map(({ extension, binding }) =>
      Context.make(NativeConversationExtension, extension).pipe(
        Context.add(NativeConversationBinding, binding),
      ),
    ),
  ),
);
