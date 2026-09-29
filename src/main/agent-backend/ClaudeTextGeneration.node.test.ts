import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { ClaudeSdkOpenInput } from "../platform/node/ClaudeSdk";
import { ClaudeSdk } from "../platform/node/ClaudeSdk";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { MainConfig } from "../app/MainConfig";
import { make } from "./ClaudeTextGeneration";

const setup = (output: unknown) => {
  const opens: ClaudeSdkOpenInput[] = [];
  const instances: string[] = [];
  const prompts: string[] = [];
  let closed = 0;
  return {
    opens,
    instances,
    prompts,
    closed: () => closed,
    service: make.pipe(
      Effect.provideService(MainConfig, { environment: { HOME: "/user", PATH: "/bin" } } as never),
      Effect.provideService(ApplicationSettings, {
        claudeLaunchConfiguration: (instanceId: string) =>
          Effect.sync(() => {
            instances.push(instanceId);
            return {
              instance: {
                id: instanceId,
                displayName: "Chosen instance",
                binaryPath: "/bin/claude",
                enabled: true,
                environment: [],
              },
              environment: { ANTHROPIC_BASE_URL: "https://gateway.example" },
            };
          }),
      } as never),
      Effect.provideService(ClaudeSdk, {
        open: (input: ClaudeSdkOpenInput) =>
          Effect.gen(function* () {
            opens.push(input);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed += 1;
              }),
            );
            return {
              messages: Stream.make({
                type: "result",
                subtype: "success",
                is_error: false,
                structured_output: output,
              } as never),
              send: (text: string) =>
                Effect.sync(() => {
                  prompts.push(text);
                }),
            };
          }),
      } as never),
    ),
  };
};

it.effect(
  "explicit title generation selects one instance and closes a bounded nonpersistent helper",
  () =>
    Effect.gen(function* () {
      const fixture = setup({ title: "Add project search" });
      const service = yield* fixture.service;
      assert.equal(
        yield* service.title({
          instanceConfigId: "work",
          cwd: "/workspace",
          prompt: "Add search",
          model: "haiku",
        }),
        "Add project search",
      );
      assert.deepEqual(fixture.instances, ["work"]);
      assert.lengthOf(fixture.opens, 1);
      assert.deepInclude(fixture.opens[0], {
        purpose: "helper",
        resume: false,
        persistSession: false,
        permissionMode: "dontAsk",
        cwd: "/workspace",
        model: "haiku",
      });
      assert.isDefined(fixture.opens[0]!.outputSchema);
      assert.isUndefined(fixture.opens[0]!.launchContext);
      assert.equal(fixture.closed(), 1);
      assert.lengthOf(fixture.prompts, 1);
      const permission = yield* fixture.opens[0]!.canUseTool({
        name: "Bash",
        input: { command: "echo test" },
        toolUseId: "attempt",
      });
      assert.equal(permission.behavior, "deny");
    }),
);

it.effect("malformed or oversized helper output retains the existing title", () =>
  Effect.gen(function* () {
    for (const output of [
      { title: "x".repeat(121) },
      { title: "first\nsecond" },
      { title: "valid", extra: "wrong" },
      { title: "x".repeat(17_000) },
    ]) {
      const fixture = setup(output);
      const service = yield* fixture.service;
      assert.isNull(
        yield* service.title({ instanceConfigId: "work", cwd: "/workspace", prompt: "Add search" }),
      );
      assert.equal(fixture.closed(), 1);
    }
    const fixture = setup({ title: "unused" });
    const service = yield* fixture.service;
    assert.isNull(
      yield* service.title({
        instanceConfigId: "work",
        cwd: "/workspace",
        prompt: "x".repeat(8001),
      }),
    );
    assert.lengthOf(fixture.opens, 0);
  }),
);
