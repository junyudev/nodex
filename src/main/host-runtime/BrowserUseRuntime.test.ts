import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import type { BrowserSidebarEvent } from "../browser/BrowserSidebarEventHub";
import { BrowserUseRuntime, testLayer } from "./BrowserUseRuntime";

it.effect("owns Browser Use routing, turn lifecycle, and physical registry with its Scope", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    let registryReleased = 0;
    let chromeProviderReady = false;
    const browserEvents = yield* PubSub.unbounded<BrowserSidebarEvent>();
    const registry = {
      availableBackends: () => ["iab"] as const,
      captureRoute: (route: { codexSessionId: string }) =>
        Effect.sync(() => void events.push(`capture:${route.codexSessionId}`)),
      focusPresentation: ({ tabId }: { tabId: number }) =>
        Effect.sync(() => {
          events.push(`focus:${tabId}`);
          return true;
        }),
      notifyCursorArrived: () => Effect.sync(() => void events.push("cursor")),
      releaseOwner: () => Effect.sync(() => void events.push("release-owner")),
      releaseSession: (sessionId: string) =>
        Effect.sync(() => void events.push(`release-session:${sessionId}`)),
      turnEnded: ({ turnId }: { turnId: string }) =>
        Effect.sync(() => void events.push(`turn-ended:${turnId}`)),
      turnStarted: ({ turnId }: { turnId: string }) =>
        Effect.sync(() => void events.push(`turn-started:${turnId}`)),
    };
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      testLayer({
        browserEvents: Stream.fromPubSub(browserEvents),
        chromeProviderReady: () => chromeProviderReady,
        makeRegistry: Effect.addFinalizer(() =>
          Effect.sync(() => {
            registryReleased += 1;
          }),
        ).pipe(Effect.as(registry)),
        releaseCredentialOwner: () =>
          Effect.sync(() => void events.push("release-credential-owner")),
      }),
      scope,
    );
    const runtime = Context.get(context, BrowserUseRuntime);

    assert.deepEqual(runtime.availableBackends(), ["iab"]);
    chromeProviderReady = true;
    assert.deepEqual(runtime.availableBackends(), ["iab", "chrome"]);
    chromeProviderReady = false;
    yield* runtime.captureRoute({
      browserConversationId: "conversation",
      browserViewScopeId: "scope",
      codexSessionId: "session",
      ownerWebContentsId: 1,
      projectId: null,
    });
    yield* runtime.promoteRoute({
      browserConversationId: "conversation",
      browserViewScopeId: "scope",
      codexSessionId: "promoted-session",
      projectId: "project",
    });
    assert.isTrue(yield* runtime.focusPresentation({ sessionId: "promoted-session", tabId: 7 }));
    yield* runtime.turnStarted({ sessionId: "promoted-session", turnId: "turn-1" });
    yield* runtime.turnEnded({ sessionId: "promoted-session", turnId: "turn-1" });
    yield* runtime.releaseSession("promoted-session");
    yield* PubSub.publish(browserEvents, {
      kind: "browserUseOwnerReleased",
      value: { ownerWebContentsId: 1 },
    });
    yield* PubSub.publish(browserEvents, {
      kind: "browserUseCursorArrived",
      value: {
        browserConversationId: "conversation",
        browserViewScopeId: "scope",
        browserTabId: "tab",
        moveSequence: 1,
        ownerWebContentsId: 1,
      },
    });
    yield* Effect.yieldNow;
    assert.includeMembers(events, [
      "capture:session",
      "capture:promoted-session",
      "focus:7",
      "cursor",
      "release-credential-owner",
      "release-owner",
      "release-session:promoted-session",
      "turn-ended:turn-1",
      "turn-started:turn-1",
    ]);
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          runtime.promoteRoute({
            browserConversationId: "conversation",
            browserViewScopeId: "scope",
            codexSessionId: "released-session",
            projectId: "project",
          }),
        ),
      ),
    );

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(registryReleased, 1);
  }),
);
