import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@nodex/runtime-contracts";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { fromRunner, type Request, type Runner } from "./textGenerationOperations.ts";

const schema = { type: "object", required: ["title"] };
const generate = (options: Parameters<typeof fromRunner>[2]) =>
  Effect.gen(function* () {
    const requests: Request<never>[] = [];
    const run = ((request: Request<never>) => {
      requests.push(request);
      return Effect.succeed({ title: "Fix login" });
    }) as unknown as Runner;
    const reply = yield* fromRunner("Test", run, options).generateStructured({
      cwd: "/workspace",
      prompt: "Title this chat",
      modelSelection: { instanceId: ProviderInstanceId.make("test"), model: "model" },
      outputSchema: schema,
    });
    return { reply, request: requests[0]! };
  });

it.effect("a provider that enforces schemas receives the prompt and schema apart", () =>
  Effect.gen(function* () {
    const { reply, request } = yield* generate({ enforcesJsonSchema: true });
    expect(reply).toEqual({ title: "Fix login" });
    expect(request.prompt).toBe("Title this chat");
    expect(request.jsonSchema).toEqual(schema);
  }),
);

it.effect("a provider that cannot enforce schemas is asked for the shape in its prompt", () =>
  Effect.gen(function* () {
    const { request } = yield* generate({});
    expect(request.prompt.startsWith("Title this chat\n\n")).toBe(true);
    expect(request.prompt).toContain(JSON.stringify(schema));
  }),
);
