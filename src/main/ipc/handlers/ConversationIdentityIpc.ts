import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { z } from "zod";
import { MainConfig } from "../../app/MainConfig";
import { isTrustedAppRendererIpcSender } from "../../app-renderer-ipc-authorization";
import {
  ConversationIdentityError,
  ConversationIdentityQuery,
} from "../../conversation-application/ConversationIdentityQuery";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

const threadIdentityInput = z.string().trim().max(512);

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const identities = yield* ConversationIdentityQuery;
    const ipc = yield* ElectronIpc;
    const config = yield* MainConfig;
    const windows = yield* WindowRuntime;
    yield* ipc.handleQuery("conversation:identity:get", (event, input) =>
      Effect.try({
        try: () => {
          if (
            !isTrustedAppRendererIpcSender({
              developmentOrigin: config.rendererUrl,
              hasOwnerWindow: windows.has(event.sender.id),
              senderType: event.sender.getType(),
              senderUrl: event.senderFrame?.url ?? "",
              isMainFrame: event.senderFrame === event.sender.mainFrame,
            })
          )
            throw new Error("Conversation identity requires an active Nodex window");
          return threadIdentityInput.parse(input);
        },
        catch: (cause) => new ConversationIdentityError({ cause }),
      }).pipe(Effect.flatMap(identities.resolve)),
    );
  }),
);
