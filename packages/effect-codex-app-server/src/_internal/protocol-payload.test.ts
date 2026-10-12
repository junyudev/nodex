import { assert, expectTypeOf, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as CodexRpc from "../_generated/meta.gen.ts";
import * as Shared from "./shared.ts";

it.effect("exposes the JSON numeric and optional contracts of decoded responses", () =>
  Effect.gen(function* () {
    type Terminal =
      CodexRpc.ClientRequestResponsesByMethod["thread/backgroundTerminals/list"]["data"][number];
    type Usage = CodexRpc.ClientRequestResponsesByMethod["account/usage/read"];
    expectTypeOf<Terminal["rssKb"]>().toEqualTypeOf<number | null | undefined>();
    expectTypeOf<Usage["summary"]["lifetimeTokens"]>().toEqualTypeOf<number | null | undefined>();
    expectTypeOf<
      NonNullable<Usage["dailyUsageBuckets"]>[number]["tokens"]
    >().toEqualTypeOf<number>();

    const schema = CodexRpc.CLIENT_REQUEST_RESPONSES["thread/backgroundTerminals/list"];
    const response = {
      data: [
        {
          command: "sleep 30",
          cwd: "/workspace",
          itemId: "item",
          processId: "process",
          rssKb: 512,
        },
      ],
    } satisfies typeof schema.Type &
      CodexRpc.ClientRequestResponsesByMethod["thread/backgroundTerminals/list"];
    assert.deepEqual(yield* Schema.decodeUnknownEffect(schema)(response), response);
  }),
);

it.effect("allows absent optional request fields while keeping dictionary value types", () =>
  Effect.gen(function* () {
    const schema = CodexRpc.CLIENT_REQUEST_PARAMS["thread/list"];
    expectTypeOf<(typeof schema.Type)["cursor"]>().toEqualTypeOf<string | null | undefined>();
    const params = { cursor: undefined } satisfies typeof schema.Type &
      CodexRpc.ClientRequestParamsByMethod["thread/list"];
    assert.deepEqual(yield* Shared.encodeOptionalPayload("thread/list", schema, params), {});

    type Project = CodexRpc.ClientRequestParamsByMethod["project/create"];
    expectTypeOf<NonNullable<Project["metadata"]>>().toEqualTypeOf<{
      readonly [key: string]: string;
    }>();
    expectTypeOf<
      CodexRpc.ClientRequestParamsByMethod["config/value/write"]["value"]
    >().toEqualTypeOf<Schema.Json>();
  }),
);

it.effect("requires value guards for extension keys inside declared unions", () =>
  Effect.gen(function* () {
    type Input = CodexRpc.ClientRequestParamsByMethod["turn/start"]["input"][number];
    type Text = Extract<Input, { type: "text" }>;
    type Element = NonNullable<Text["text_elements"]>[number];
    expectTypeOf<Input["extension"]>().toEqualTypeOf<unknown>();
    expectTypeOf<Element["extension"]>().toEqualTypeOf<unknown>();
    expectTypeOf<Element["byteRange"]["start"]>().toEqualTypeOf<number>();

    const imageSource = (input: Input): string | undefined => {
      if (input.type !== "image") return undefined;
      if ("fileId" in input) expectTypeOf<typeof input.fileId>().toEqualTypeOf<unknown>();
      if (typeof input.fileId === "string") return input.fileId;
      return typeof input.url === "string" ? input.url : undefined;
    };
    const schema = CodexRpc.CLIENT_REQUEST_PARAMS["turn/start"];
    const decoded = yield* Schema.decodeUnknownEffect(schema)({
      threadId: "thread",
      input: [
        { type: "image", fileId: "file", extension: { origin: "camera" } },
        { type: "image", url: "https://example.com/image.png", fileId: 123 },
      ],
    });
    assert.equal(imageSource(decoded.input[0]!), "file");
    assert.equal(imageSource(decoded.input[1]!), "https://example.com/image.png");
  }),
);
