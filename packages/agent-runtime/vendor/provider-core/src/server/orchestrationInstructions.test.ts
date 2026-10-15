import { assert, describe, it } from "@effect/vitest";

import { acpPromptWithInstructions } from "./orchestrationInstructions.ts";

const guidance = "## Nodex tools\n\nUse task tools.";

describe("ACP prompt instructions", () => {
  it("wraps mode and host guidance around the user's request", () => {
    const injected = acpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasAppTools: true },
      hostOrchestrationInstructions: guidance,
    });

    assert.include(injected, "Nodex interaction mode: Default");
    assert.include(injected, guidance);
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("reinjects guidance only when mode, tool availability or host context changes", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasAppTools: true } as const;

    assert.equal(
      acpPromptWithInstructions({ prompt, state: defaultState, previousState: defaultState }),
      prompt,
    );
    assert.include(
      acpPromptWithInstructions({
        prompt,
        state: { ...defaultState, interactionMode: "plan" },
        previousState: defaultState,
      }),
      "Nodex interaction mode: Plan",
    );
    const withoutTools = acpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasAppTools: false },
      hostOrchestrationInstructions: guidance,
    });
    assert.include(withoutTools, "Nodex interaction mode: Default");
    assert.notInclude(withoutTools, guidance);
  });

  it("leaves native slash commands untouched", () => {
    assert.equal(
      acpPromptWithInstructions({
        prompt: "/compact",
        state: { interactionMode: "plan", hasAppTools: true },
        hostOrchestrationInstructions: guidance,
      }),
      "/compact",
    );
  });
});
