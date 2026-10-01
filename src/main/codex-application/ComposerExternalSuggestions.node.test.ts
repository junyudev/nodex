import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import {
  parseComposerChatGptConversations,
  parseComposerSitesToolResponse,
} from "../codex/composer-external-suggestion-projection";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { ChatGptDesktop } from "./ChatGptDesktop";
import {
  ComposerExternalSuggestions,
  live as suggestionsLive,
} from "./ComposerExternalSuggestions";

const unsupported = () => Effect.die(new Error("Unsupported test operation"));

const gateway = CodexGateway.of({
  localHostId: "local",
  requestRawOnHost: () => Effect.die(new Error("Unsupported raw host request")),
  requestRawForThread: () => Effect.die(new Error("Unsupported raw request")),
  events: Stream.empty,
  requestLocal: ((method: string) => {
    if (method === "config/read")
      return Effect.succeed({ config: { chatgpt_base_url: "https://chatgpt.test" } });
    throw new Error(`Unexpected request: ${method}`);
  }) as CodexGateway["Service"]["requestLocal"],
  requestOnHost: unsupported,
  requestForThread: unsupported,
  notifyLocal: unsupported,
  connection: unsupported,
  connectionChanges: () => Stream.empty,
  awaitReady: () => Effect.void,
  reconcileHost: unsupported,
  removeHost: unsupported,
  restartHost: unsupported,
});

const build = (chatgpt: ChatGptDesktop["Service"], scope: Scope.Closeable) =>
  Layer.buildWithScope(
    suggestionsLive.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(CodexGateway, gateway), Layer.succeed(ChatGptDesktop, chatgpt)),
      ),
    ),
    scope,
  );

it.effect("projects Sites and ChatGPT suggestions behind account availability", () =>
  Effect.gen(function* () {
    const requests: string[] = [];
    const scope = yield* Scope.make();
    const context = yield* build(
      ChatGptDesktop.of({
        prepareRequest: () => Effect.die("unused"),
        authStatus: () => Effect.die(new Error("unused")),
        authMethod: Effect.succeed("chatgpt"),
        request: (input) => {
          requests.push(input.path);
          if (input.path === "/wham/sites/access") {
            return Effect.succeed(new Response(JSON.stringify({ enabled: true }), { status: 200 }));
          }
          if (input.path === "/wham/apps") {
            return Effect.succeed(
              new Response(
                JSON.stringify({
                  result: {
                    structuredContent: {
                      items: [{ id: "site-a", slug: "site-a", title: "Site A" }],
                    },
                  },
                }),
                { status: 200 },
              ),
            );
          }
          return Effect.succeed(
            new Response(
              JSON.stringify({ items: [{ conversation_id: "chat-a", title: "Chat A" }] }),
              { status: 200 },
            ),
          );
        },
      }),
      scope,
    );
    const suggestions = Context.get(context, ComposerExternalSuggestions);
    assert.deepEqual(yield* suggestions.listSites, {
      available: true,
      sites: [
        {
          id: "site-a",
          title: "Site A",
          slug: "site-a",
          currentLiveUrl: null,
          path: "sites-project://site-a",
        },
      ],
    });
    assert.deepEqual(yield* suggestions.listChatGptConversations(" agent "), {
      available: true,
      conversations: [
        {
          conversationId: "chat-a",
          title: "Chat A",
          path: "chatgpt-conversation://chat-a",
        },
      ],
    });
    assert.include(requests.at(-1) ?? "", "/conversations/search?query=agent");
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("returns unavailable without issuing ChatGPT requests for API-key accounts", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* build(
      ChatGptDesktop.of({
        prepareRequest: () => Effect.die("unused"),
        authStatus: () => Effect.die(new Error("unused")),
        authMethod: Effect.succeed("apikey"),
        request: () => Effect.die(new Error("request should not run")),
      }),
      scope,
    );
    const suggestions = Context.get(context, ComposerExternalSuggestions);
    assert.deepEqual(yield* suggestions.listSites, { available: false, sites: [] });
    assert.deepEqual(yield* suggestions.listChatGptConversations(""), {
      available: false,
      conversations: [],
    });
    yield* Scope.close(scope, Exit.void);
  }),
);

it("rejects failed Sites payloads and deduplicates malformed conversation rows", () => {
  assert.deepEqual(
    parseComposerSitesToolResponse({
      result: { isError: true, structuredContent: { items: [] } },
    }),
    [],
  );
  assert.deepEqual(
    parseComposerChatGptConversations({
      items: [
        { conversation_id: "conversation-1", title: null },
        { id: "conversation-1", title: "duplicate" },
        { id: "", title: "invalid" },
      ],
    }),
    [
      {
        conversationId: "conversation-1",
        title: "",
        path: "chatgpt-conversation://conversation-1",
      },
    ],
  );
});
