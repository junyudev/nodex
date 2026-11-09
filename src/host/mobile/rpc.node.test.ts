import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vitest";
import { HostInvocation } from "../HostInvocation";
import { invokeMobileRpc, type MobileHandlers } from "./rpc";

it.effect("refuses a phone call without Member invocation before invoking its owner", () =>
  Effect.gen(function* () {
    let calls = 0;
    const handlers = {
      "projects.list": () =>
        Effect.sync(() => {
          calls++;
          return { projects: [], libraryInboxCount: 0 };
        }),
    } as unknown as MobileHandlers;
    const refused = yield* Effect.result(invokeMobileRpc(handlers, "projects.list", {}));
    expect(refused).toMatchObject({
      _tag: "Failure",
      failure: { code: "rejected", retryable: false },
    });
    expect(calls).toBe(0);
    const admitted = yield* invokeMobileRpc(handlers, "projects.list", {}).pipe(
      Effect.provideService(HostInvocation, "core-invocation-context"),
    );
    expect(admitted).toEqual({ projects: [], libraryInboxCount: 0 });
    expect(calls).toBe(1);
  }),
);
