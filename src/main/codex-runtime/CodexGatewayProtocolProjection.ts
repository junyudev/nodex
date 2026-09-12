import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import type { ThreadResumeParams } from "@nodex/codex-app-server-protocol/v2/ThreadResumeParams";
import type { Thread } from "@nodex/codex-app-server-protocol/v2/Thread";
import type { ThreadResumeResponse } from "@nodex/codex-app-server-protocol/v2/ThreadResumeResponse";

export type CodexGatewayThreadReadThread = ClientRequestResponsesByMethod["thread/read"]["thread"];

/**
 * The Effect client and the transport-neutral protocol package are generated from the same
 * app-server schema. The Effect codec exposes decoded values as readonly and keeps legacy fields
 * optional; the existing canonical reducer still consumes the ts-rs mutable/required-null view.
 * This is the sole type projection between those generated views and performs no data conversion.
 */
export const projectCodexGatewayThreadReadThread = (thread: CodexGatewayThreadReadThread): Thread =>
  thread as unknown as Thread;

export type CodexGatewayThreadResumeResponse = ClientRequestResponsesByMethod["thread/resume"];

/** Same generated-schema projection as Thread read, including resume permission context. */
export const projectCodexGatewayThreadResumeResponse = (
  response: CodexGatewayThreadResumeResponse,
): ThreadResumeResponse => response as unknown as ThreadResumeResponse;

/** The Gateway validates the generated request at dispatch; this projects its TS view only. */
export const projectCodexGatewayThreadResumeParams = (
  params: ThreadResumeParams,
): ClientRequestParamsByMethod["thread/resume"] =>
  params as unknown as ClientRequestParamsByMethod["thread/resume"];

/** Configuration has the same JSON wire grammar in both generated packages. */
export const projectCodexGatewayThreadConfig = (
  config: NonNullable<ClientRequestParamsByMethod["thread/start"]["config"]>,
): NonNullable<ThreadResumeParams["config"]> =>
  config as unknown as NonNullable<ThreadResumeParams["config"]>;
