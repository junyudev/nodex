import { describe, expect, it } from "vite-plus/test";
import { distributeObjectUnions, parseCodexRequestEntries } from "./codex-schema-generator";

describe("Effect Codex schema generation", () => {
  it("keeps requests whose generated params property is optional", () => {
    expect(
      parseCodexRequestEntries(`
        | { "method": "account/usage/read", id: RequestId, params?: GetUsageParams | undefined }
        | { "method": "thread/start", id: RequestId, params: ThreadStartParams };
      `),
    ).toEqual([
      { method: "account/usage/read", paramsType: "GetUsageParams | undefined" },
      { method: "thread/start", paramsType: "ThreadStartParams" },
    ]);
  });

  it.each(["oneOf", "anyOf"])("distributes shared object fields over %s branches", (union) => {
    expect(
      distributeObjectUnions({
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
        [union]: [
          {
            type: "object",
            title: "CommandHook",
            properties: {
              handlerType: { const: "command" },
              command: { type: "string" },
            },
            required: ["handlerType", "command"],
          },
          {
            type: "object",
            properties: { handlerType: { const: "agent" } },
            required: ["handlerType"],
          },
        ],
      }),
    ).toEqual({
      [union]: [
        {
          type: "object",
          title: "CommandHook",
          properties: {
            key: { type: "string" },
            handlerType: { const: "command" },
            command: { type: "string" },
          },
          required: ["key", "handlerType", "command"],
        },
        {
          type: "object",
          properties: {
            key: { type: "string" },
            handlerType: { const: "agent" },
          },
          required: ["key", "handlerType"],
        },
      ],
    });
  });
});
