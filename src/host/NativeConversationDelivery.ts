import * as Context from "effect/Context";
import type { CodexTurnCommands } from "../main/codex-application/CodexTurnCommands";

/** Optional native remote-chat delivery. Runtime-bound local Sessions use Runtime exclusively. */
export class NativeConversationDelivery extends Context.Service<
  NativeConversationDelivery,
  Pick<CodexTurnCommands["Service"], "start">
>()("nodex/host/NativeConversationDelivery") {}
