import { expect, it } from "vite-plus/test";
import {
  applyRuntimeClaudeIntent,
  readRuntimeClaudeSelection,
  resolveRuntimeClaudeIntent,
  runtimeClaudeModelOption,
} from "./agent-runtime-model-intent";
import type { AgentRuntimeProvider } from "./agent-runtime-conversation-adapter";

const binding = { kind: "claude" as const, instanceConfigId: "claude" };
const model = (slug: string, full: boolean): AgentRuntimeProvider["models"][number] => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "effort",
        label: "Effort",
        type: "select",
        options: (full ? ["low", "medium", "high", "max"] : ["low", "medium"]).map((id) => ({
          id,
          label: id,
        })),
      },
      ...(full
        ? [
            { id: "fastMode", label: "Speed", type: "boolean" as const },
            { id: "ultracode", label: "Ultracode", type: "boolean" as const },
            { id: "thinking", label: "Thinking", type: "boolean" as const },
            {
              id: "contextWindow",
              label: "Context",
              type: "select" as const,
              options: [{ id: "1m", label: "1M" }],
            },
          ]
        : []),
    ],
  },
});

it("fits one model without destroying the intent restored on a later model switch", () => {
  const intent = {
    model: "full",
    effort: "max" as const,
    fast: true,
    thinking: false,
    context: "1m",
  };
  const bounded = applyRuntimeClaudeIntent(
    { binding, model: "small" },
    { ...intent, model: "small" },
    model("small", false),
  );
  expect(readRuntimeClaudeSelection(bounded)).toEqual({
    model: "small",
    effort: "medium",
    fast: false,
  });
  const retained = resolveRuntimeClaudeIntent(
    bounded,
    { ...intent, model: "small" },
    model("small", false),
  );
  const restored = applyRuntimeClaudeIntent(
    { binding, model: "full" },
    { ...retained, model: "full" },
    model("full", true),
  );
  expect(readRuntimeClaudeSelection(restored)).toEqual(intent);
});

it("accepts an external execution selection when old intent no longer explains it", () => {
  const applied = {
    binding,
    model: "full",
    options: [
      { id: "effort", value: "low" },
      { id: "fastMode", value: false },
    ],
  };
  expect(
    resolveRuntimeClaudeIntent(
      applied,
      { model: "full", effort: "max", fast: true },
      model("full", true),
    ),
  ).toEqual({ model: "full", effort: "low", fast: false });
});

it("keeps unknown model intent for native resolution and preserves independent supported options", () => {
  const selection = { binding, model: "custom", options: [{ id: "independent", value: "chosen" }] };
  expect(
    applyRuntimeClaudeIntent(
      selection,
      { model: "custom", effort: "high", thinking: false },
      undefined,
    ).options,
  ).toEqual([
    { id: "independent", value: "chosen" },
    { id: "effort", value: "high" },
    { id: "thinking", value: false },
  ]);
});

it("carries Ultracode at any effort and keeps it for a model switch back", () => {
  const intent = { model: "full", effort: "low" as const, ultracode: true };
  const applied = applyRuntimeClaudeIntent({ binding, model: "full" }, intent, model("full", true));
  expect(applied.options).toEqual([
    { id: "effort", value: "low" },
    { id: "ultracode", value: true },
  ]);
  expect(readRuntimeClaudeSelection(applied)).toEqual(intent);

  const unsupported = applyRuntimeClaudeIntent(
    { binding, model: "small" },
    { ...intent, model: "small" },
    model("small", false),
  );
  expect(readRuntimeClaudeSelection(unsupported)).toEqual({
    model: "small",
    effort: "low",
    ultracode: false,
  });
  expect(
    resolveRuntimeClaudeIntent(unsupported, { ...intent, model: "small" }, model("small", false)),
  ).toEqual({ ...intent, model: "small" });
});

it("keeps Ultracode intent but runs without it while the account cannot use it", () => {
  const unavailable: AgentRuntimeProvider["models"][number] = {
    ...model("full", true),
    capabilities: {
      optionDescriptors: (model("full", true).capabilities?.optionDescriptors ?? []).map(
        (descriptor) =>
          descriptor.id === "ultracode" && descriptor.type === "boolean"
            ? { ...descriptor, unavailableReason: "Dynamic workflows are off." }
            : descriptor,
      ),
    },
  };
  expect(runtimeClaudeModelOption(unavailable)).toMatchObject({
    ultracode: false,
    ultracodeUnavailableReason: "Dynamic workflows are off.",
  });
  const intent = { model: "full", effort: "high" as const, ultracode: true };
  const applied = applyRuntimeClaudeIntent({ binding, model: "full" }, intent, unavailable);
  expect(readRuntimeClaudeSelection(applied).ultracode).toBe(false);
  expect(resolveRuntimeClaudeIntent(applied, intent, unavailable)).toEqual(intent);
});
