import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { providerKeyModelDiscovery } from "./ProviderKeyModelDiscovery";

const custom = { preset: "custom", baseUrl: "https://gateway.example/anthropic" } as const;
const deepseek = { preset: "deepseek", endpoint: "international" } as const;
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
    expect(yield* discover({ preset: "zhipu", endpoint: "china" }, key)).toMatchObject({
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
