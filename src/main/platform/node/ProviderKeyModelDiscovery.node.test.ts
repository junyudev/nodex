import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { providerKeyModelDiscovery } from "./ProviderKeyModelDiscovery";

const custom = {
  preset: "custom",
  baseUrl: "https://gateway.example/anthropic",
  agent: "claudeAgent",
} as const;
const deepseek = { preset: "deepseek", endpoint: "international", agent: "claudeAgent" } as const;
const keyText = "test-secret-value";
const key = Redacted.make(keyText);

it.effect("reads Anthropic model pages using the same origin and omits reflected credentials", () =>
  Effect.gen(function* () {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: [
            { id: "claude-v1", display_name: "Claude V1" },
            { id: keyText, display_name: keyText },
          ],
          has_more: true,
          last_id: "claude-v1",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [{ id: "claude-v2", display_name: keyText }, { id: "embed-only" }],
          has_more: false,
        }),
      );
    expect(yield* providerKeyModelDiscovery(request)(custom, key)).toEqual({
      ok: true,
      models: [
        { id: "claude-v1", name: "Claude V1" },
        { id: "claude-v2", name: "Claude V2" },
      ],
    });
    expect(request.mock.calls[1]?.[0].toString()).toBe(
      "https://gateway.example/anthropic/v1/models?after_id=claude-v1",
    );
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: {
        Authorization: `Bearer ${keyText}`,
        "x-api-key": keyText,
        "anthropic-version": "2023-06-01",
      },
    });
  }),
);

it.effect.each([
  new Response(null, { status: 404 }),
  new Response(null, { status: 405 }),
  Response.json({ unrelated: true }),
])("falls back from an unavailable Anthropic listing to the OpenAI model endpoint", (first) =>
  Effect.gen(function* () {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(
        Response.json({
          data: [{ id: "deepseek-v4-pro", name: "Pro label" }, { id: "other-provider-model" }],
        }),
      );
    expect(yield* providerKeyModelDiscovery(request)(deepseek, key)).toEqual({
      ok: true,
      models: [{ id: "deepseek-v4-pro", name: "Pro label" }],
    });
    expect(request.mock.calls[1]?.[0].toString()).toBe("https://api.deepseek.com/models");
    expect(request.mock.calls[1]?.[1]?.headers).toEqual({ Authorization: `Bearer ${keyText}` });
  }),
);

it.effect.each([
  () => new Response(null, { status: 401 }),
  () => new Response(null, { status: 403 }),
  () => Response.json({ code: 401, message: "refused" }),
  () => Response.json({ error: { type: "authentication_error", message: "refused" } }),
])("rejects HTTP and in-body authentication failures before any fallback", (response) =>
  Effect.gen(function* () {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const discover = providerKeyModelDiscovery(request);
    expect(
      yield* discover({ preset: "zhipu", endpoint: "china", agent: "claudeAgent" }, key),
    ).toMatchObject({
      ok: false,
      reason: "rejected",
    });
    expect(request).toHaveBeenCalledTimes(1);
  }),
);

it.effect("uses preset defaults when the list contains no supported models", () =>
  Effect.gen(function* () {
    const discover = providerKeyModelDiscovery(async () =>
      Response.json({ data: [{ id: "unrelated-model" }] }),
    );
    expect(yield* discover(deepseek, key)).toMatchObject({
      ok: true,
      models: [{ id: "deepseek-v4-pro" }, { id: "deepseek-flash" }],
    });
  }),
);

it.effect("uses typed models only when the custom endpoint cannot list models", () =>
  Effect.gen(function* () {
    const discover = providerKeyModelDiscovery(async () => new Response(null, { status: 404 }));
    const models = [{ id: "manual-model", name: "My model" }];
    expect(yield* discover(custom, key)).toMatchObject({
      ok: false,
      reason: "no-models",
    });
    expect(yield* discover(custom, key, models)).toEqual({
      ok: true,
      models,
    });
  }),
);

it.effect("classifies network and server failures as unreachable even with typed models", () =>
  Effect.gen(function* () {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(new Response(null, { status: 500 }));
    const discover = providerKeyModelDiscovery(request);
    for (const _ of [1, 2]) {
      expect(yield* discover(custom, key, [{ id: "manual", name: "Manual" }])).toMatchObject({
        ok: false,
        reason: "unreachable",
      });
    }
  }),
);

it.effect("discovers Codex models and merges listed Responses traits over preset traits", () =>
  Effect.gen(function* () {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [
          {
            id: "deepseek-flash",
            display_name: "DeepSeek Flash",
            context_window: 900_000,
            input_modalities: ["text"],
            effort: { supported_levels: ["low", "max"], default_level: "low" },
          },
          {
            id: "deepseek-v4-pro",
            context_window: -1,
            input_modalities: "not an array",
            effort: { default_level: "a".repeat(40) },
          },
        ],
        has_more: true,
        last_id: "deepseek-v4-pro",
      }),
    );
    const result = yield* providerKeyModelDiscovery(request)({ ...deepseek, agent: "codex" }, key);
    expect(result).toEqual({
      ok: true,
      models: [
        {
          id: "deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          contextWindow: 1_048_576,
          reasoningEfforts: ["low", "high", "max"],
          defaultReasoningEffort: "high",
        },
        {
          id: "deepseek-flash",
          name: "DeepSeek Flash",
          contextWindow: 900_000,
          images: false,
          reasoningEfforts: ["low", "max"],
          defaultReasoningEffort: "low",
        },
      ],
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0].toString()).toBe("https://api.deepseek.com/models");
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: { Authorization: `Bearer ${keyText}` },
    });
  }),
);

it.effect.each([404, 405])(
  "tries the preset's alternate Responses listing after HTTP %i",
  (status) =>
    Effect.gen(function* () {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(
          Response.json({
            data: [{ id: "glm-5.3", input_modalities: ["text", "image"] }],
          }),
        );
      const result = yield* providerKeyModelDiscovery(request)(
        { preset: "zhipu", endpoint: "china", agent: "codex" },
        key,
      );
      expect(result).toMatchObject({ ok: true, models: [{ id: "glm-5.3", images: true }] });
      expect(request.mock.calls.map(([url]) => url.toString())).toEqual([
        "https://open.bigmodel.cn/api/v1/models",
        "https://open.bigmodel.cn/api/paas/v4/models",
      ]);
      expect(request.mock.calls[1]?.[1]?.headers).toEqual({ Authorization: `Bearer ${keyText}` });
    }),
);

it.effect("ignores reflected credentials in Responses model traits and labels", () =>
  Effect.gen(function* () {
    const discover = providerKeyModelDiscovery(async () =>
      Response.json({
        data: [
          {
            id: "custom-model",
            display_name: "a".repeat(124) + keyText,
            effort: { supported_levels: ["low", keyText], default_level: keyText },
          },
        ],
      }),
    );
    const result = yield* discover({ ...custom, agent: "codex" }, key);
    expect(result).toEqual({
      ok: true,
      models: [{ id: "custom-model", name: "Custom Model", reasoningEfforts: ["low"] }],
    });
  }),
);
