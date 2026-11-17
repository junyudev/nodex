import { registerFindRequests } from "../../find/FindRequests";
import { CoreModules } from "../../core-runtime/CoreModules";
import { findBlockSource, makeFindService } from "../../find/FindService";
import { LibraryModule } from "../../library-application/LibraryModule";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { IpcMainInvokeEvent } from "electron";
import { MainConfig } from "../../app/MainConfig";
import { ChatSearch, ChatSearchError } from "../../chat-search/ChatSearch";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

/** Picker queries enter the Profile-scoped search owner through the trusted renderer boundary. */
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const search = yield* ChatSearch;
    const library = yield* LibraryModule;
    const core = yield* CoreModules;
    const find = makeFindService({
      ...search,
      searchPages: library.searchPages,
      searchBlocks: findBlockSource(core),
    });
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
    yield* registerFindRequests(ipc, find, authorize);
  }),
);
