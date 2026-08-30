import type { IpcApi } from "../../shared/ipc-api";
import type { CoreErrorDetail } from "../../shared/core-result";
import type {
  CoreLocalCommitCommandChannel as PolicyCoreLocalCommitCommandChannel,
  IpcCommandChannelFor,
  IpcControlChannel,
  IpcQueryChannel,
  MainRevisionCommandChannel,
  PlainResultCommandChannel,
} from "../../shared/ipc-endpoint-policy";
import { parseLocalCommitApply, type LocalCommitApply } from "../../shared/local-commit-delivery";
import { CoreApiError } from "./core-api-error";
import { admitLocalCommitApply } from "./local-commit-ingress";
import {
  beginRendererCommandTrace,
  recordRendererCommandTrace,
  type RendererCausalTraceContext,
  type RendererCausalTraceScopeKind,
} from "./renderer-causal-trace";
import {
  invokeRendererControlThrough,
  invokeRendererQueryThrough,
  type RendererQueryControlPort,
} from "./renderer-query-control";

export { invokeRendererControlThrough, invokeRendererQueryThrough } from "./renderer-query-control";

export type RendererCommandAuthority = "core" | "main" | "renderer" | "external";

declare const rendererCommandDefinitionBrand: unique symbol;

export type RendererVisibilityProtocol =
  | {
      readonly kind: "receipt_fenced_projection";
      readonly presentation: "required" | "placeholder" | "pending";
    }
  | { readonly kind: "local_document_replica" }
  | { readonly kind: "local_scene_outbox" }
  | { readonly kind: "revision_fenced_local" }
  | { readonly kind: "returned_value" }
  | { readonly kind: "pending_operation" };

export type LocalCommitVisibilityProtocol = Extract<
  RendererVisibilityProtocol,
  {
    readonly kind:
      | "receipt_fenced_projection"
      | "local_document_replica"
      | "local_scene_outbox"
      | "returned_value"
      | "pending_operation";
  }
>;

export type AllowedAcknowledgement<
  Authority extends RendererCommandAuthority,
  Protocol extends RendererVisibilityProtocol,
> = Protocol extends {
  readonly kind: "receipt_fenced_projection" | "local_document_replica" | "local_scene_outbox";
}
  ? Authority extends "core"
    ? "core_local_commit"
    : never
  : Protocol extends { readonly kind: "revision_fenced_local" }
    ? Authority extends "main" | "renderer"
      ? "main_revision"
      : never
    : Protocol extends { readonly kind: "pending_operation" }
      ? Authority extends "core"
        ? "core_local_commit" | "plain_result"
        : Authority extends "external"
          ? "plain_result"
          : "main_revision" | "plain_result"
      : Authority extends "core"
        ? "core_local_commit"
        : Authority extends "external"
          ? "plain_result"
          : "main_revision" | "plain_result";

export interface RendererCommandDefinition<
  Key extends string,
  Authority extends RendererCommandAuthority,
  Protocol extends RendererVisibilityProtocol,
  Channel extends IpcCommandChannelFor<AllowedAcknowledgement<Authority, Protocol>>,
> {
  readonly [rendererCommandDefinitionBrand]: true;
  readonly key: Key;
  readonly channel: Channel;
  readonly authority: Authority;
  readonly owner: string;
  readonly protocol: Protocol;
  readonly trace?: { readonly scopeKind: RendererCausalTraceScopeKind };
}

export const defineRendererCommand = <
  const Key extends string,
  const Authority extends RendererCommandAuthority,
  const Protocol extends RendererVisibilityProtocol,
  const Channel extends IpcCommandChannelFor<AllowedAcknowledgement<Authority, Protocol>>,
>(
  definition: Omit<
    RendererCommandDefinition<Key, Authority, Protocol, Channel>,
    typeof rendererCommandDefinitionBrand
  >,
): RendererCommandDefinition<Key, Authority, Protocol, Channel> =>
  definition as RendererCommandDefinition<Key, Authority, Protocol, Channel>;

type LocalCommitSuccess<Channel extends keyof IpcApi> = Extract<
  IpcApi[Channel]["result"],
  { readonly ok: true; readonly localCommit: unknown; readonly value: unknown }
>;

export type CoreLocalCommitCommandChannel = {
  [Channel in PolicyCoreLocalCommitCommandChannel]: [LocalCommitSuccess<Channel>] extends [never]
    ? never
    : Channel;
}[PolicyCoreLocalCommitCommandChannel];

type LocalCommitCommandValue<Channel extends CoreLocalCommitCommandChannel> =
  LocalCommitSuccess<Channel>["value"];

type LocalCommitFailure<Channel extends CoreLocalCommitCommandChannel> = Extract<
  IpcApi[Channel]["result"],
  { readonly ok: false }
>;

export type AdmittedLocalCommitCommandResult<Channel extends CoreLocalCommitCommandChannel> =
  | (Omit<LocalCommitSuccess<Channel>, "localCommit"> & {
      readonly localCommit: LocalCommitApply;
    })
  | LocalCommitFailure<Channel>;

export type RendererCommandInvokePort = RendererQueryControlPort;

export type LocalCommitCommandInvokePort = RendererCommandInvokePort;

const resolveInvokeTransport = (): RendererCommandInvokePort => {
  const bridge = typeof window === "undefined" ? undefined : window.api;
  if (!bridge) throw new Error("Nodex renderer requires the Electron preload bridge");
  return bridge;
};

export interface LocalCommitRendererCommandDefinition<
  Key extends string,
  Channel extends CoreLocalCommitCommandChannel,
  Protocol extends LocalCommitVisibilityProtocol,
> {
  readonly [rendererCommandDefinitionBrand]: true;
  readonly key: Key;
  readonly channel: Channel;
  readonly authority: "core";
  readonly owner: string;
  readonly protocol: Protocol;
  readonly trace?: { readonly scopeKind: RendererCausalTraceScopeKind };
}

export const defineLocalCommitRendererCommand = <
  const Key extends string,
  const Channel extends CoreLocalCommitCommandChannel,
  const Protocol extends LocalCommitVisibilityProtocol,
>(
  definition: Omit<
    LocalCommitRendererCommandDefinition<Key, Channel, Protocol>,
    typeof rendererCommandDefinitionBrand
  >,
): LocalCommitRendererCommandDefinition<Key, Channel, Protocol> =>
  definition as LocalCommitRendererCommandDefinition<Key, Channel, Protocol>;

type IpcArgs<Channel extends keyof IpcApi> = IpcApi[Channel]["args"] extends readonly unknown[]
  ? IpcApi[Channel]["args"]
  : never;

export function invokeRendererQuery<Channel extends IpcQueryChannel>(
  channel: Channel,
  ...args: IpcArgs<Channel>
): Promise<IpcApi[Channel]["result"]> {
  return invokeRendererQueryThrough(resolveInvokeTransport(), channel, ...args);
}

export function invokeRendererControl<Channel extends IpcControlChannel>(
  channel: Channel,
  ...args: IpcArgs<Channel>
): Promise<IpcApi[Channel]["result"]> {
  return invokeRendererControlThrough(resolveInvokeTransport(), channel, ...args);
}

interface TraceableRendererCommandDefinition {
  readonly key: string;
  readonly owner: string;
  readonly protocol: { readonly kind: RendererVisibilityProtocol["kind"] };
  readonly trace?: { readonly scopeKind: RendererCausalTraceScopeKind };
}

const assertTraceMatchesDefinition = (
  definition: TraceableRendererCommandDefinition,
  trace: RendererCausalTraceContext | null,
): void => {
  if (!trace) return;
  if (
    trace.semanticKey === definition.key &&
    trace.owner === definition.owner &&
    trace.protocol === definition.protocol.kind
  ) {
    return;
  }
  throw new TypeError("Renderer command trace context does not match its semantic definition");
};

const beginSubmittedTrace = (
  definition: TraceableRendererCommandDefinition,
  args: readonly unknown[],
): RendererCausalTraceContext | null => {
  const context = beginRendererCommandTrace(definition, args);
  recordRendererCommandTrace(context, { kind: "submitted", reason: "transport_submit" });
  return context;
};

export async function invokePlainCommand<
  const Key extends string,
  const Authority extends RendererCommandAuthority,
  const Protocol extends RendererVisibilityProtocol,
  const Channel extends PlainResultCommandChannel &
    IpcCommandChannelFor<AllowedAcknowledgement<Authority, Protocol>>,
>(
  definition: RendererCommandDefinition<Key, Authority, Protocol, Channel>,
  ...args: IpcArgs<Channel>
): Promise<IpcApi[Channel]["result"]> {
  return await invokePlainCommandThrough(definition, resolveInvokeTransport(), ...args);
}

/**
 * Uses an owning Module's lifecycle context so local presentation and transport
 * evidence describe one operation even when its wire payload has no identity field.
 */
export async function invokePlainCommandWithTrace<
  const Key extends string,
  const Authority extends RendererCommandAuthority,
  const Protocol extends RendererVisibilityProtocol,
  const Channel extends PlainResultCommandChannel &
    IpcCommandChannelFor<AllowedAcknowledgement<Authority, Protocol>>,
>(
  definition: RendererCommandDefinition<Key, Authority, Protocol, Channel>,
  trace: RendererCausalTraceContext | null,
  ...args: IpcArgs<Channel>
): Promise<IpcApi[Channel]["result"]> {
  assertTraceMatchesDefinition(definition, trace);
  return await invokePlainCommandThroughTrace(definition, resolveInvokeTransport(), trace, ...args);
}

export async function invokePlainCommandThrough<
  const Key extends string,
  const Authority extends RendererCommandAuthority,
  const Protocol extends RendererVisibilityProtocol,
  const Channel extends PlainResultCommandChannel &
    IpcCommandChannelFor<AllowedAcknowledgement<Authority, Protocol>>,
>(
  definition: RendererCommandDefinition<Key, Authority, Protocol, Channel>,
  transport: RendererCommandInvokePort,
  ...args: IpcArgs<Channel>
): Promise<IpcApi[Channel]["result"]> {
  return await invokePlainCommandThroughTrace(definition, transport, null, ...args);
}

const invokePlainCommandThroughTrace = async <
  const Key extends string,
  const Authority extends RendererCommandAuthority,
  const Protocol extends RendererVisibilityProtocol,
  const Channel extends PlainResultCommandChannel &
    IpcCommandChannelFor<AllowedAcknowledgement<Authority, Protocol>>,
>(
  definition: RendererCommandDefinition<Key, Authority, Protocol, Channel>,
  transport: RendererCommandInvokePort,
  trace: RendererCausalTraceContext | null,
  ...args: IpcArgs<Channel>
): Promise<IpcApi[Channel]["result"]> => {
  if (trace) {
    recordRendererCommandTrace(trace, { kind: "submitted", reason: "transport_submit" });
  }
  let result: unknown;
  try {
    result = await transport.invoke(definition.channel, ...args);
  } catch (cause) {
    if (trace) {
      recordRendererCommandTrace(trace, { kind: "failed", reason: "transport_failure" });
    }
    throw cause;
  }
  if (trace) {
    recordRendererCommandTrace(
      trace,
      definition.protocol.kind === "pending_operation"
        ? { kind: "pending", reason: "accepted_pending" }
        : { kind: "result", reason: "terminal_result" },
    );
  }
  return result as IpcApi[Channel]["result"];
};

type RevisionedSuccess<Channel extends MainRevisionCommandChannel> = Extract<
  IpcApi[Channel]["result"],
  { readonly ok: true; readonly revision: number; readonly value: unknown }
>;

type DirectRevisionedResult<Channel extends MainRevisionCommandChannel> =
  IpcApi[Channel]["result"] extends {
    readonly revision: number;
    readonly value: unknown;
  }
    ? IpcApi[Channel]["result"]
    : never;

type RevisionedAcknowledgement<Channel extends MainRevisionCommandChannel> =
  | RevisionedSuccess<Channel>
  | DirectRevisionedResult<Channel>;

type CompatibleMainRevisionCommandChannel = {
  [Channel in MainRevisionCommandChannel]: [RevisionedAcknowledgement<Channel>] extends [never]
    ? never
    : Channel;
}[MainRevisionCommandChannel];

export async function invokeRevisionedCommand<
  const Key extends string,
  const Authority extends "main" | "renderer",
  const Protocol extends Extract<
    RendererVisibilityProtocol,
    { readonly kind: "revision_fenced_local" }
  >,
  const Channel extends CompatibleMainRevisionCommandChannel &
    IpcCommandChannelFor<AllowedAcknowledgement<Authority, Protocol>>,
>(
  definition: RendererCommandDefinition<Key, Authority, Protocol, Channel>,
  ...args: IpcArgs<Channel>
): Promise<IpcApi[Channel]["result"]> {
  const trace = beginSubmittedTrace(definition, args);
  let result: unknown;
  try {
    result = await resolveInvokeTransport().invoke(
      definition.channel,
      ...(args as unknown as readonly unknown[]),
    );
  } catch (cause) {
    recordRendererCommandTrace(trace, { kind: "failed", reason: "transport_failure" });
    throw cause;
  }
  if (typeof result === "object" && result !== null && "ok" in result && result.ok === false) {
    recordRendererCommandTrace(trace, { kind: "failed", reason: "domain_failure" });
    return result as IpcApi[Channel]["result"];
  }
  if (
    typeof result !== "object" ||
    result === null ||
    !("revision" in result) ||
    !Number.isSafeInteger(result.revision) ||
    !("value" in result)
  ) {
    recordRendererCommandTrace(trace, { kind: "failed", reason: "invalid_acknowledgement" });
    throw new TypeError("Revisioned command acknowledgement is invalid");
  }
  recordRendererCommandTrace(trace, { kind: "acknowledged", reason: "revision_accepted" });
  recordRendererCommandTrace(trace, { kind: "result", reason: "transport_result" });
  return result as IpcApi[Channel]["result"];
}

export interface AdmittedLocalCommitResult<Value> {
  readonly value: Value;
  readonly acknowledgement: LocalCommitApply;
}

/** Typed command rejection that is not a Core transport failure. */
export class RendererCommandRejectedError<Result extends { readonly ok: false }> extends Error {
  readonly result: Result;

  constructor(result: Result) {
    super("Renderer command was rejected by its domain policy");
    this.name = "RendererCommandRejectedError";
    this.result = result;
  }
}

/**
 * Invokes a registered Core command through an explicit transport port while
 * preserving typed domain failures for provider-owned retry state machines.
 */
export async function invokeLocalCommitCommandResultThrough<
  const Key extends string,
  const Channel extends CoreLocalCommitCommandChannel,
  const Protocol extends LocalCommitVisibilityProtocol,
>(
  definition: LocalCommitRendererCommandDefinition<Key, Channel, Protocol>,
  transport: LocalCommitCommandInvokePort,
  ...args: IpcArgs<Channel>
): Promise<AdmittedLocalCommitCommandResult<Channel>> {
  const trace = beginSubmittedTrace(definition, args);
  let result: IpcApi[Channel]["result"];
  try {
    result = (await transport.invoke(definition.channel, ...args)) as IpcApi[Channel]["result"];
  } catch (cause) {
    recordRendererCommandTrace(trace, { kind: "failed", reason: "transport_failure" });
    throw cause;
  }
  if (!result.ok) {
    recordRendererCommandTrace(trace, { kind: "failed", reason: "domain_failure" });
    return result as LocalCommitFailure<Channel>;
  }

  const success = result as LocalCommitSuccess<Channel>;
  let acknowledgement: LocalCommitApply;
  try {
    acknowledgement = parseLocalCommitApply(success.localCommit);
  } catch (cause) {
    recordRendererCommandTrace(trace, { kind: "failed", reason: "invalid_acknowledgement" });
    throw cause;
  }
  recordRendererCommandTrace(
    trace,
    acknowledgement.status === "no_op"
      ? { kind: "no_op", reason: "no_op" }
      : { kind: "acknowledged", reason: "committed" },
  );
  try {
    await admitLocalCommitApply(acknowledgement);
  } catch (cause) {
    recordRendererCommandTrace(trace, { kind: "failed", reason: "delivery_admission_failure" });
    throw cause;
  }
  if (definition.protocol.kind === "pending_operation") {
    recordRendererCommandTrace(trace, { kind: "pending", reason: "accepted_pending" });
  } else {
    recordRendererCommandTrace(trace, { kind: "result", reason: "transport_result" });
  }
  return {
    ...success,
    localCommit: acknowledgement,
  } as AdmittedLocalCommitCommandResult<Channel>;
}

export async function invokeLocalCommitCommandResult<
  const Key extends string,
  const Channel extends CoreLocalCommitCommandChannel,
  const Protocol extends LocalCommitVisibilityProtocol,
>(
  definition: LocalCommitRendererCommandDefinition<Key, Channel, Protocol>,
  ...args: IpcArgs<Channel>
): Promise<AdmittedLocalCommitCommandResult<Channel>> {
  return await invokeLocalCommitCommandResultThrough(definition, resolveInvokeTransport(), ...args);
}

/**
 * Invokes one registered Core command and admits its exact apply evidence
 * before the owning renderer Module can observe a successful result.
 */
export async function invokeLocalCommitCommand<
  const Key extends string,
  const Channel extends CoreLocalCommitCommandChannel,
  const Protocol extends LocalCommitVisibilityProtocol,
>(
  definition: LocalCommitRendererCommandDefinition<Key, Channel, Protocol>,
  ...args: IpcArgs<Channel>
): Promise<AdmittedLocalCommitResult<LocalCommitCommandValue<Channel>>> {
  const result = await invokeLocalCommitCommandResult(definition, ...args);
  if (!result.ok) {
    const failure = result as LocalCommitFailure<Channel>;
    if (
      "error" in failure &&
      typeof failure.error === "object" &&
      failure.error !== null &&
      "recovery" in failure.error
    ) {
      throw new CoreApiError(failure.error as CoreErrorDetail);
    }
    throw new RendererCommandRejectedError(failure);
  }
  const success = result as LocalCommitSuccess<Channel> & {
    readonly localCommit: LocalCommitApply;
  };
  return {
    value: success.value as LocalCommitCommandValue<Channel>,
    acknowledgement: success.localCommit,
  };
}
