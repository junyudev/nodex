import { describe, expect, test } from "vitest";
import {
  applyCodexDefaultModeRequestUserInput,
  filterCodexExecutionFeaturesForAppServer,
  parseCodexExecutionInstructionOverrides,
  projectCodexExecutionFeaturesToThreadConfig,
  projectCodexExecutionMemoryPromptsToThreadConfig,
} from "./codex-execution-assignments";

describe("Codex execution feature projection", () => {
  test("strips overrides unsupported by the target app-server version", () => {
    const features = {
      apply_patch_preserve_line_endings: true,
      compaction_image_budget: true,
      deferred_tool_world_state: true,
      mcp_oauth_refresh_coordination: true,
      recommended_plugins: true,
      thread_tools: true,
      guardianv2: { enabled: true, mode: "strict" },
    };

    expect(filterCodexExecutionFeaturesForAppServer(features, "0.145.0")).toEqual({
      thread_tools: true,
      guardianv2: true,
    });
    expect(filterCodexExecutionFeaturesForAppServer(features, "0.154.0-alpha.1")).toEqual(features);
    expect(filterCodexExecutionFeaturesForAppServer(features, "0.0.0")).toEqual(features);
  });

  test("preserves the source compaction image budget prerelease exceptions", () => {
    const features = { compaction_image_budget: true };
    expect(filterCodexExecutionFeaturesForAppServer(features, "0.149.0-alpha.4.2")).toEqual({});
    expect(filterCodexExecutionFeaturesForAppServer(features, "0.149.0-alpha.4.3")).toEqual(
      features,
    );
    expect(filterCodexExecutionFeaturesForAppServer(features, "0.149.0-alpha.7.2")).toEqual({});
    expect(filterCodexExecutionFeaturesForAppServer(features, "0.149.0-alpha.7.3")).toEqual(
      features,
    );
    expect(filterCodexExecutionFeaturesForAppServer(features, "0.150.0-alpha.12")).toEqual({});
    expect(filterCodexExecutionFeaturesForAppServer(features, "0.149.1")).toEqual(features);
  });

  test("projects only thread config features and lets explicit config override defaults", () => {
    expect(
      projectCodexExecutionFeaturesToThreadConfig({
        unified_exec: true,
        "features.thread_tools": true,
        apps: true,
        plugins: true,
        recommended_plugins: true,
        tool_suggest: true,
        auth_elicitation: true,
        tool_call_mcp_elicitation: true,
        writing_blocks: true,
      }),
    ).toEqual({
      "features.unified_exec": true,
      "features.thread_tools": true,
      "features.recommended_plugins": true,
    });
  });

  test("only suppresses a remotely enabled default-mode request-user-input feature", () => {
    expect(
      applyCodexDefaultModeRequestUserInput(
        { default_mode_request_user_input: true, unified_exec: true },
        false,
      ),
    ).toEqual({ default_mode_request_user_input: false, unified_exec: true });
    expect(
      applyCodexDefaultModeRequestUserInput(
        { default_mode_request_user_input: false, unified_exec: true },
        true,
      ),
    ).toEqual({ default_mode_request_user_input: false, unified_exec: true });
  });

  test("parses model instruction overrides with exact trimming and memory prompt limits", () => {
    const parsed = parseCodexExecutionInstructionOverrides({
      desktop_context_section: "  desktop context  ",
      workspace_dependencies_section: "   ",
      memory_read_prompt: "  keep memory whitespace  ",
      memory_phase_one_prompt: "phase one",
      ignored: "value",
    });
    expect(parsed).toEqual({
      desktopContextSection: "desktop context",
      memoryReadPrompt: "  keep memory whitespace  ",
      memoryPhaseOnePrompt: "phase one",
    });
    expect(parseCodexExecutionInstructionOverrides({ memory_read_prompt: "   " })).toBeNull();
    expect(
      parseCodexExecutionInstructionOverrides({ memory_read_prompt: "é".repeat(32_769) }),
    ).toBeNull();
    expect(parseCodexExecutionInstructionOverrides({ desktop_context_section: 42 })).toBeNull();
  });

  test("projects local memory prompt overrides onto the app-server config namespace", () => {
    expect(
      projectCodexExecutionMemoryPromptsToThreadConfig({
        desktopContextSection: "desktop",
        memoryReadPrompt: "read",
        memoryPhaseOnePrompt: "one",
        memoryPhaseTwoPrompt: "two",
      }),
    ).toEqual({
      "memories.read_prompt": "read",
      "memories.phase_one_prompt": "one",
      "memories.phase_two_prompt": "two",
    });
  });
});
