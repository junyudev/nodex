import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HostDesktopTools, headless } from "./HostDesktopTools";

it.effect("headless chats advertise no GUI tools for either Claude or Codex", () =>
  Effect.gen(function* () {
    const tools = yield* HostDesktopTools;
    assert.isNull(yield* tools.desktopTools);
    assert.deepEqual(yield* tools.threadConfig("/workspace"), {});
  }).pipe(Effect.provide(headless)),
);
