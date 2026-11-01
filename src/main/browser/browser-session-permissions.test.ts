import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  BrowserSessionPermissions,
  type BrowserPermissionPage,
} from "./browser-session-permissions";
import {
  makeBrowserPermissionStore,
  type BrowserPermissionStore,
} from "./browser-permission-store";
import { makeBrowserSiteInfoRuntime } from "./browser-site-info-provider";
import type {
  BrowserPermissionAction,
  BrowserPermissionPrompt,
  BrowserSitePermissionName,
} from "../../shared/browser/browser-permissions";

const identity = {
  browserConversationId: "conversation",
  browserViewScopeId: "scope",
  browserTabId: "tab",
};
const origin = "https://example.com";
const makeFixture = (store: BrowserPermissionStore) => {
  let page: BrowserPermissionPage | null = {
    ...identity,
    rendererInstanceId: "renderer",
    mountGeneration: 2,
    hostGeneration: 3,
    ownerWebContentsId: 7,
    webContentsId: 101,
    url: `${origin}/page`,
    navigationVersion: 1,
    presented: true,
    hasUserGesture: false,
  };
  let prompts: BrowserPermissionPrompt[] = [];
  const results: boolean[] = [];
  const opened: BrowserSitePermissionName[] = [];
  const osDenied = new Set<BrowserSitePermissionName>();
  const runtime = new BrowserSessionPermissions(
    {
      findPage: (id) => (id === page?.webContentsId ? page : null),
      publish: (_identity, values) => {
        prompts = values;
      },
      systemStatus: (permission) => (osDenied.has(permission) ? "denied" : "granted"),
      openSystemSettings: async (permission) => {
        opened.push(permission);
      },
    },
    store,
  );
  const request = (
    permission: Parameters<BrowserSessionPermissions["request"]>[1],
    details: Partial<Parameters<BrowserSessionPermissions["request"]>[3]> = {},
  ) => {
    runtime.request({ id: 101 } as never, permission, (result) => results.push(result), {
      isMainFrame: true,
      requestingUrl: `${origin}/page`,
      ...details,
    });
  };
  const check = (
    permission: Parameters<BrowserSessionPermissions["check"]>[1],
    mediaType?: "video" | "audio" | "unknown",
  ) => runtime.check({ id: 101 } as never, permission, origin, { isMainFrame: true, mediaType });
  const prompt = () => {
    const value = prompts.at(-1);
    if (!value) throw new Error("Expected a permission prompt");
    return value;
  };
  const response = (action: BrowserPermissionAction) => ({
    ...identity,
    type: "respond-permission" as const,
    promptId: prompt().id,
    mountGeneration: 2,
    action,
  });
  const patchPage = (patch: Partial<BrowserPermissionPage>) => {
    if (!page) throw new Error("Page is unavailable");
    page = { ...page, ...patch };
  };
  return {
    runtime,
    request,
    check,
    prompt,
    response,
    results,
    opened,
    osDenied,
    patchPage,
    losePage: () => {
      page = null;
    },
    prompts: () => prompts,
  };
};

const withStore = <A, E, R>(
  run: (store: BrowserPermissionStore, filePath: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "nodex-browser-permissions-"))),
    (root) =>
      Effect.gen(function* () {
        const filePath = path.join(root, "browser-permissions.json");
        return yield* run(yield* makeBrowserPermissionStore(filePath), filePath);
      }),
    (root) => Effect.sync(() => fs.rmSync(root, { recursive: true, force: true })),
  );

it.layer(NodeServices.layer)("Browser permissions", (it) => {
  it.effect(
    "combines camera and microphone in one origin-attributed prompt and holds the callback",
    () =>
      withStore((store) =>
        Effect.sync(() => {
          const fixture = makeFixture(store);
          fixture.request("media", {
            mediaTypes: ["video", "audio"],
            securityOrigin: "https://frame.example",
          });
          assert.deepEqual(fixture.results, []);
          assert.lengthOf(fixture.prompts(), 1);
          assert.deepInclude(fixture.prompt(), {
            origin: "https://frame.example",
            embeddingOrigin: origin,
            permissions: [{ name: "camera" }, { name: "microphone" }],
            actions: ["allow", "allow-this-time", "deny", "dismiss"],
            variant: "permission",
          });
          fixture.runtime.dispose();
          assert.deepEqual(fixture.results, [false]);
        }),
      ),
  );

  it.effect(
    "grants browser-default categories without prompting and requires activation for clipboard auto-grants",
    () =>
      withStore((store) =>
        Effect.sync(() => {
          const fixture = makeFixture(store);
          for (const permission of [
            "fullscreen",
            "pointerLock",
            "keyboardLock",
            "mediaKeySystem",
            "screen-wake-lock",
            "sensors",
            "background-sync",
            "background-fetch",
            "payment-handler",
          ] as const) {
            fixture.request(permission);
            assert.isTrue(fixture.check(permission));
          }
          assert.deepEqual(fixture.results, Array(9).fill(true));
          assert.isEmpty(fixture.prompts());
          fixture.request("clipboard-sanitized-write");
          assert.strictEqual(fixture.prompt().permissions[0]?.name, "clipboard-write");
          fixture.runtime.release(101);
          fixture.patchPage({ hasUserGesture: true });
          fixture.request("clipboard-sanitized-write", { isMainFrame: false });
          assert.strictEqual(fixture.results.at(-1), true);
          assert.isEmpty(fixture.prompts());
          assert.isTrue(fixture.check("clipboard-sanitized-write"));
        }),
      ),
  );

  it.effect("denies device and display capture requests without a chooser", () =>
    withStore((store) =>
      Effect.sync(() => {
        const fixture = makeFixture(store);
        for (const permission of [
          "hid",
          "serial",
          "usb",
          "display-capture",
          "speaker-selection",
          "fileSystem",
          "unknown",
        ] as const)
          fixture.request(permission);
        assert.deepEqual(fixture.results, Array(7).fill(false));
        assert.isEmpty(fixture.prompts());
      }),
    ),
  );

  for (const action of ["allow", "deny", "dismiss", "allow-this-time"] as const) {
    it.effect(`${action} resolves once and applies the correct persistence lifetime`, () =>
      withStore((store, filePath) =>
        Effect.gen(function* () {
          const fixture = makeFixture(store);
          fixture.request("media", { mediaTypes: ["video", "audio"] });
          const response = fixture.response(action);
          assert.deepEqual(yield* fixture.runtime.respond(response, 7), { ok: true });
          assert.deepEqual(fixture.results, [action === "allow" || action === "allow-this-time"]);
          assert.isEmpty(fixture.prompts());
          assert.isFalse((yield* fixture.runtime.respond(response, 7)).ok);
          const reloaded = yield* makeBrowserPermissionStore(filePath);
          const persisted = action === "allow" ? "allow" : action === "deny" ? "block" : undefined;
          assert.strictEqual(reloaded.get(origin, "camera"), persisted);
          assert.strictEqual(reloaded.get(origin, "microphone"), persisted);
          assert.strictEqual(
            fixture.check("media", "audio"),
            action === "allow" || action === "allow-this-time",
          );
          fixture.request("media", { mediaTypes: ["audio"] });
          if (action === "dismiss") {
            assert.lengthOf(fixture.prompts(), 1);
            fixture.runtime.dispose();
            return;
          }
          assert.lengthOf(fixture.results, 2);
          assert.isEmpty(fixture.prompts());
          fixture.runtime.navigation(101, `${origin}/another-page`);
          assert.strictEqual(fixture.check("media", "video"), action !== "deny");
          fixture.runtime.navigation(101, "https://other.example/");
          assert.strictEqual(fixture.check("media", "video"), action === "allow");
        }),
      ),
    );
  }

  it.effect("rejects foreign owners, tabs, prompt IDs, generations and navigation versions", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const fixture = makeFixture(store);
        fixture.request("notifications");
        const response = fixture.response("allow");
        for (const invalid of [
          { ...response, promptId: "foreign" },
          { ...response, browserTabId: "foreign" },
          { ...response, browserConversationId: "foreign" },
          { ...response, browserViewScopeId: "foreign" },
          { ...response, mountGeneration: 1 },
        ])
          assert.isFalse((yield* fixture.runtime.respond(invalid, 7)).ok);
        assert.isFalse((yield* fixture.runtime.respond(response, 8)).ok);
        for (const patch of [
          { presented: false },
          { navigationVersion: 2 },
          { rendererInstanceId: "new" },
          { mountGeneration: 3 },
          { hostGeneration: 4 },
          { ownerWebContentsId: 8 },
        ]) {
          fixture.patchPage(patch);
          assert.isFalse((yield* fixture.runtime.respond(response, 7)).ok);
          fixture.patchPage({
            presented: true,
            navigationVersion: 1,
            rendererInstanceId: "renderer",
            mountGeneration: 2,
            hostGeneration: 3,
            ownerWebContentsId: 7,
          });
        }
        assert.isUndefined(store.get(origin, "notifications"));
        assert.isEmpty(fixture.results);
        fixture.losePage();
        assert.isFalse((yield* fixture.runtime.respond(response, 7)).ok);
        fixture.runtime.dispose();
        assert.deepEqual(fixture.results, [false]);
      }),
    ),
  );

  it.effect(
    "dismisses pending callbacks on navigation, close and teardown without remembering a block",
    () =>
      withStore((store) =>
        Effect.sync(() => {
          const fixture = makeFixture(store);
          fixture.request("notifications");
          fixture.runtime.navigation(101, `${origin}/next`);
          fixture.request("geolocation");
          fixture.runtime.release(101);
          fixture.request("clipboard-read");
          fixture.runtime.dispose();
          assert.deepEqual(fixture.results, [false, false, false]);
          assert.isEmpty(fixture.prompts());
          assert.isUndefined(store.get(origin, "notifications"));
        }),
      ),
  );

  it.effect(
    "reflects persisted decisions for page and worker checks without conflating media kinds",
    () =>
      withStore((store) =>
        Effect.gen(function* () {
          yield* store.set(origin, ["camera", "notifications"], "allow");
          yield* store.set(origin, ["microphone"], "block");
          const fixture = makeFixture(store);
          assert.isTrue(fixture.check("media", "video"));
          assert.isFalse(fixture.check("media", "audio"));
          assert.isFalse(fixture.check("media", "unknown"));
          assert.isTrue(
            fixture.runtime.check(null, "notifications", origin, { isMainFrame: false }),
          );
          assert.isFalse(
            fixture.runtime.check(null, "notifications", "https://other.example", {
              isMainFrame: false,
            }),
          );
          fixture.request("media", { mediaTypes: ["video", "audio"] });
          assert.deepEqual(fixture.results, [false]);
          assert.isEmpty(fixture.prompts());
        }),
      ),
  );

  it.effect("reports real site permission state and resets one or all decisions", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const fixture = makeFixture(store);
        const site = makeBrowserSiteInfoRuntime(
          { getTabSnapshot: () => ({ url: `${origin}/page`, webContentsId: 101 }) },
          { get: async () => [] },
          fixture.runtime,
        );
        yield* store.set(origin, ["camera"], "allow");
        yield* store.set(origin, ["notifications"], "block");
        const state = (yield* site.get(identity)).permissions;
        assert.deepInclude(state, { permission: "camera", state: "allow" });
        assert.deepInclude(state, { permission: "notifications", state: "block" });
        assert.deepInclude(state, { permission: "geolocation", state: "ask" });
        assert.deepInclude(state, { permission: "display-capture", state: "block" });
        yield* fixture.runtime.reset(origin, "camera");
        assert.deepInclude((yield* site.get(identity)).permissions, {
          permission: "camera",
          state: "ask",
        });
        assert.strictEqual(store.get(origin, "notifications"), "block");
        fixture.request("geolocation");
        yield* fixture.runtime.respond(fixture.response("allow-this-time"), 7);
        yield* fixture.runtime.reset(origin);
        assert.deepInclude((yield* site.get(identity)).permissions, {
          permission: "geolocation",
          state: "ask",
        });
        assert.deepInclude((yield* site.get(identity)).permissions, {
          permission: "notifications",
          state: "ask",
        });
      }),
    ),
  );

  it.effect(
    "offers OS settings when system access is blocked and validates available actions and accuracy",
    () =>
      withStore((store) =>
        Effect.gen(function* () {
          const fixture = makeFixture(store);
          fixture.osDenied.add("camera");
          fixture.request("media", { mediaTypes: ["video"] });
          const response = fixture.response("allow");
          assert.strictEqual(fixture.prompt().variant, "os-system-settings");
          assert.deepEqual(fixture.prompt().actions, ["dismiss"]);
          assert.isFalse((yield* fixture.runtime.respond(response, 7)).ok);
          const settings = {
            ...identity,
            type: "open-permission-system-settings" as const,
            promptId: response.promptId,
            mountGeneration: 2,
          };
          assert.isFalse((yield* fixture.runtime.openSystemSettings(settings, 8)).ok);
          assert.isTrue((yield* fixture.runtime.openSystemSettings(settings, 7)).ok);
          assert.deepEqual(fixture.opened, ["camera"]);
          yield* fixture.runtime.respond({ ...response, action: "dismiss" }, 7);
          fixture.request("geolocation");
          assert.isFalse(
            (yield* fixture.runtime.respond(
              { ...fixture.response("allow"), geolocationAccuracy: "approximate" },
              7,
            )).ok,
          );
          assert.isFalse(
            (yield* fixture.runtime.openSystemSettings(
              { ...settings, promptId: fixture.prompt().id },
              7,
            )).ok,
          );
          fixture.runtime.dispose();
        }),
      ),
  );

  it.effect("serializes concurrent decisions and quarantines invalid durable input", () =>
    withStore((store, filePath) =>
      Effect.gen(function* () {
        yield* Effect.all(
          [store.set(origin, ["camera"], "allow"), store.set(origin, ["microphone"], "block")],
          { concurrency: "unbounded" },
        );
        const reloaded = yield* makeBrowserPermissionStore(filePath);
        assert.strictEqual(reloaded.get(origin, "camera"), "allow");
        assert.strictEqual(reloaded.get(origin, "microphone"), "block");
        fs.writeFileSync(
          filePath,
          JSON.stringify({
            schemaVersion: 1,
            decisions: [
              { origin: "https://example.com/path", permission: "camera", state: "allow" },
            ],
          }),
        );
        const empty = yield* makeBrowserPermissionStore(filePath);
        assert.isUndefined(empty.get(origin, "camera"));
        assert.isTrue(
          fs
            .readdirSync(path.dirname(filePath))
            .some((name) => name.startsWith("browser-permissions.json.corrupt-")),
        );
      }),
    ),
  );
});
