import type { DictationSurface } from "./dictation";
import type { RpcTarget } from "capnweb";

export const DICTATION_STREAM_CONNECT_CHANNEL = "codex:dictation:stream:connect";
export const DICTATION_STREAM_CONNECT_MESSAGE = "connect-dictation-stream";
export const DICTATION_STREAM_MAX_MESSAGE_LENGTH = 8_388_608;

/** Only these selected request fields can leave Main; credentials and routing URLs cannot. */
export interface DictationStreamRequestHeaders {
  readonly originator: string;
  readonly userAgent: string;
  readonly authorizationPresent: boolean;
  readonly accountHeaderPresent: boolean;
}

export type DictationStreamNetworkError = "dns" | "tls" | "proxy" | "reset" | "timeout" | "other";
export type DictationStreamProxyMode = "direct" | "http" | "https" | "socks";

export type DictationStreamTransportEvent =
  | {
      readonly type: "prepared";
      readonly headers: DictationStreamRequestHeaders;
      readonly proxyMode: DictationStreamProxyMode;
    }
  | { readonly type: "open"; readonly protocol: string }
  | { readonly type: "message"; readonly data: string }
  | {
      readonly type: "error";
      readonly failureCode:
        | "websocket-failed"
        | "http-rejected"
        | "edge-challenge"
        | "aborted"
        | "send-failed";
      readonly httpStatus?: number;
      readonly edgeChallenge?: "cloudflare";
      readonly networkError?: DictationStreamNetworkError;
    }
  | { readonly type: "close"; readonly code: number };

/** A capability for one authenticated Main-owned socket, bound to its RPC lifetime. */
export interface DictationStreamConnection extends RpcTarget, Disposable {
  send(data: string): void | Promise<void>;
}

export interface DictationStreamingService extends RpcTarget {
  connect(
    surface: DictationSurface,
    onEvent: (event: DictationStreamTransportEvent) => void,
  ): Promise<DictationStreamConnection>;
}
