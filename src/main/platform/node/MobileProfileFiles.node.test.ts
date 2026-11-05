import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vitest";
import { MobileProfileFiles, live } from "./MobileProfileFiles";

it.effect("request fingerprints have the form the Agent Runtime's receipts require", () =>
  Effect.gen(function* () {
    const files = yield* MobileProfileFiles;
    const fingerprint = files.contentFingerprint(JSON.stringify(["text", [], "queue"]));
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(files.contentFingerprint(JSON.stringify(["text", [], "queue"]))).toBe(fingerprint);
    expect(files.contentFingerprint(JSON.stringify(["text", [], "steer"]))).not.toBe(fingerprint);
  }).pipe(Effect.provide(live)),
);
