import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import type { ThreadResumeParams } from "@nodex/codex-app-server-protocol/v2/ThreadResumeParams";
import type { Thread } from "@nodex/codex-app-server-protocol/v2/Thread";
import type { ThreadResumeResponse } from "@nodex/codex-app-server-protocol/v2/ThreadResumeResponse";
import type { ThreadItemsListResponse } from "@nodex/codex-app-server-protocol/v2/ThreadItemsListResponse";
import type { ThreadSettingsUpdateParams } from "@nodex/codex-app-server-protocol/v2/ThreadSettingsUpdateParams";

export type CodexGatewayThreadReadThread = ClientRequestResponsesByMethod["thread/read"]["thread"];

/**
 * The Effect client and the transport-neutral protocol package are generated from the same
 * app-server schema. The Effect codec exposes decoded values as readonly and keeps legacy fields
 * optional; the existing canonical reducer still consumes the ts-rs mutable/required-null view.
 * This is the sole type projection between those generated views and performs no data conversion.
 */
export const projectCodexGatewayThreadReadThread = (thread: CodexGatewayThreadReadThread): Thread =>
  thread as unknown as Thread;

/** The item-page projection has the same generated JSON grammar and does not decode twice. */
export const projectCodexGatewayThreadItemsList = (
  page: ClientRequestResponsesByMethod["thread/items/list"],
): ThreadItemsListResponse => page as unknown as ThreadItemsListResponse;

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

/** Decoded settings use the same generated grammar with readonly JSON arrays. */
export const projectCodexGatewayThreadSettingsUpdateParams = (
  params: ClientRequestParamsByMethod["thread/settings/update"],
): ThreadSettingsUpdateParams => params as unknown as ThreadSettingsUpdateParams;
