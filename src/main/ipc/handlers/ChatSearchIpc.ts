import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { IpcMainInvokeEvent } from "electron";
import { MainConfig } from "../../app/MainConfig";
import {
  ChatSearch,
  ChatSearchError,
  ChatMessageSearchInputSchema,
  ChatSearchInputSchema,
} from "../../chat-search/ChatSearch";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

/** Picker queries enter the Profile-scoped search owner through the trusted renderer boundary. */
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const search = yield* ChatSearch;
    const ipc = yield* ElectronIpc;
    const config = yield* MainConfig;
    const windows = yield* WindowRuntime;
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Chat search", config.rendererUrl);
          if (!windows.has(event.sender.id) || event.sender.isDestroyed())
            throw new Error("Chat search requires an active Nodex window");
        },
        catch: (cause) =>
          new ChatSearchError({
            operation: "search",
            reason: "unavailable",
            message: "Chat search requires an active Nodex window",
            cause,
          }),
      });
    const parse = <A>(read: () => A) =>
      Effect.try({
        try: read,
        catch: (cause) =>
          new ChatSearchError({
            operation: "search",
            reason: "invalid_input",
            message: "Invalid chat search",
            cause,
          }),
      });
    yield* ipc.handleQuery("chats:search", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(parse(() => ChatSearchInputSchema.parse(input))),
        Effect.flatMap(search.search),
      ),
    );
    yield* ipc.handleQuery("chats:search-messages", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(parse(() => ChatMessageSearchInputSchema.parse(input))),
        Effect.flatMap(search.searchMessages),
      ),
    );
  }),
);
