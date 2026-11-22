import * as Predicate from "effect/Predicate";
import type { ChatCatalogItem } from "../chat-search/ChatCatalogProjection";
import type {
  ChatMessageSearchRequest,
  ChatRankRequest,
  ChatSearchRequest,
  SessionSearchPage,
  SessionSearchRequest,
} from "../chat-search/ChatSearchEngine";

/** Main and the worker ship in one bundle, so the message shapes change together. */
export interface ChatSearchWorkerData {
  readonly epoch: number;
}

export type ChatSearchWorkerCall =
  | { readonly method: "search"; readonly request: ChatSearchRequest }
  | { readonly method: "searchMessages"; readonly request: ChatMessageSearchRequest }
  | { readonly method: "rankSessionIds"; readonly request: ChatRankRequest };

export type ChatSearchWorkerOutcome<A = unknown> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };

export type ChatSearchWorkerHostMessage =
  | { readonly type: "publish"; readonly entries: readonly ChatCatalogItem[] }
  | { readonly type: "call"; readonly id: number; readonly call: ChatSearchWorkerCall }
  | { readonly type: "cancel"; readonly id: number }
  /** Main's answer to the worker's Runtime history request with the same id. */
  | {
      readonly type: "history";
      readonly id: number;
      readonly outcome: ChatSearchWorkerOutcome<SessionSearchPage>;
    }
  | { readonly type: "shutdown" };

export type ChatSearchWorkerThreadMessage =
  | { readonly type: "ready"; readonly epoch: number }
  | { readonly type: "result"; readonly id: number; readonly outcome: ChatSearchWorkerOutcome }
  /** Runtime history is reached through Main, which owns the Runtime connection. */
  | { readonly type: "history"; readonly id: number; readonly request: SessionSearchRequest };

const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const isOutcome = (value: unknown): value is ChatSearchWorkerOutcome =>
  Predicate.isObject(value) &&
  (value.ok === true ? "value" in value : value.ok === false && typeof value.message === "string");

export function isChatSearchWorkerHostMessage(
  value: unknown,
): value is ChatSearchWorkerHostMessage {
  if (!Predicate.isObject(value)) return false;
  switch (value.type) {
    case "publish":
      return Array.isArray(value.entries);
    case "call":
      return (
        isId(value.id) &&
        Predicate.isObject(value.call) &&
        (value.call.method === "search" ||
          value.call.method === "searchMessages" ||
          value.call.method === "rankSessionIds") &&
        Predicate.isObject(value.call.request)
      );
    case "cancel":
      return isId(value.id);
    case "history":
      return isId(value.id) && isOutcome(value.outcome);
    case "shutdown":
      return true;
    default:
      return false;
  }
}

export function isChatSearchWorkerThreadMessage(
  value: unknown,
): value is ChatSearchWorkerThreadMessage {
  if (!Predicate.isObject(value)) return false;
  switch (value.type) {
    case "ready":
      return isId(value.epoch);
    case "result":
      return isId(value.id) && isOutcome(value.outcome);
    case "history":
      return isId(value.id) && Predicate.isObject(value.request);
    default:
      return false;
  }
}
