import { describe, expect, test } from "vite-plus/test";
import {
  buildCodexAppDynamicToolFailure,
  buildCodexAppDynamicToolSuccess,
  buildCodexAppMetaThreadToolSpecs,
} from "./codex-app-meta-thread-tools";

describe("codex app meta thread tool specs", () => {
  test("advertises the Codex app meta thread tools in the codex_app namespace", () => {
    const specs = buildCodexAppMetaThreadToolSpecs({ handoffEnabled: true });
    const namespace = specs[0];
    const tools = namespace?.type === "namespace" ? namespace.tools : [];
    const toolNames = tools.map((spec) => spec.name).sort();

    expect(specs.length).toBe(1);
    expect(namespace?.type).toBe("namespace");
    expect(namespace?.name).toBe("codex_app");
    expect(JSON.stringify(toolNames)).toBe(
      JSON.stringify(
        [
          "automation_update",
          "create_sidebar_section",
          "create_thread",
          "delete_sidebar_section",
          "fork_thread",
          "get_handoff_status",
          "handoff_thread",
          "list_projects",
          "list_threads",
          "move_project_to_sidebar_section",
          "move_thread_to_sidebar_section",
          "read_thread",
          "read_thread_terminal",
          "rename_sidebar_section",
          "reorder_section",
          "reorder_sidebar_projects",
          "reorder_sidebar_sections",
          "send_message_to_thread",
          "set_thread_archived",
          "set_thread_pinned",
          "set_thread_title",
        ].sort(),
      ),
    );
    expect(tools.every((spec) => spec.type === "function")).toBe(true);

    const createThread = tools.find((spec) => spec.name === "create_thread");
    const forkThread = tools.find((spec) => spec.name === "fork_thread");
    const readThread = tools.find((spec) => spec.name === "read_thread");
    const sendMessage = tools.find((spec) => spec.name === "send_message_to_thread");
    const automationUpdate = tools.find((spec) => spec.name === "automation_update");
    const listThreads = tools.find((spec) => spec.name === "list_threads");
    const moveTask = tools.find((spec) => spec.name === "move_thread_to_sidebar_section");

    expect(JSON.stringify((createThread?.inputSchema as Record<string, unknown>).required)).toBe(
      JSON.stringify(["prompt", "target"]),
    );
    const createTarget = (
      createThread?.inputSchema as {
        properties?: { target?: { anyOf?: Array<{ properties?: Record<string, unknown> }> } };
      }
    ).properties?.target;
    const projectTarget = createTarget?.anyOf?.find(
      (branch) => branch.properties?.environment !== undefined,
    );
    const projectEnvironment = projectTarget?.properties?.environment as
      | {
          description?: string;
        }
      | undefined;
    expect(projectEnvironment?.description).toBe(
      "Where the project thread should run: directly in the saved project or in a new worktree.",
    );
    const forkEnvironment = (
      forkThread?.inputSchema as {
        properties?: { environment?: { anyOf?: Array<{ properties?: Record<string, unknown> }> } };
      }
    ).properties?.environment;
    const forkWorktree = forkEnvironment?.anyOf?.find((branch) => {
      const type = branch.properties?.type as { enum?: string[] } | undefined;
      return type?.enum?.[0] === "worktree";
    });
    expect(
      Object.prototype.hasOwnProperty.call(forkWorktree?.properties ?? {}, "startingState"),
    ).toBe(false);
    expect(
      JSON.stringify(
        (readThread?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      ).includes("maxOutputCharsPerItem"),
    ).toBe(true);
    expect(JSON.stringify((sendMessage?.inputSchema as Record<string, unknown>).required)).toBe(
      JSON.stringify(["threadId", "prompt"]),
    );
    expect(listThreads?.description).toContain("user-controlled data");
    expect(JSON.stringify((moveTask?.inputSchema as Record<string, unknown>).required)).toBe(
      JSON.stringify(["threadId", "sectionId"]),
    );
    const automationSchema = automationUpdate?.inputSchema as {
      anyOf?: Array<{
        properties?: Record<string, { enum?: string[] } | unknown>;
      }>;
    };
    const automationBranches = automationSchema.anyOf ?? [];
    const automationModes = [
      ...new Set(
        automationBranches.flatMap((branch) => {
          const mode = branch.properties?.mode as { enum?: string[] } | undefined;
          return mode?.enum ?? [];
        }),
      ),
    ].sort();
    const hasHeartbeatBranch = automationBranches.some((branch) => {
      const kind = branch.properties?.kind as { enum?: string[] } | undefined;
      return kind?.enum?.[0] === "heartbeat";
    });
    const hasSetupPathBranch = automationBranches.some(
      (branch) => branch.properties?.localEnvironmentConfigPath !== undefined,
    );

    expect(JSON.stringify(automationModes)).toBe(
      JSON.stringify(
        [
          "create",
          "delete",
          "list",
          "suggested_create",
          "suggested_update",
          "update",
          "view",
        ].sort(),
      ),
    );
    expect(hasHeartbeatBranch).toBe(true);
    expect(hasSetupPathBranch).toBe(true);
  });

  test("does not advertise handoff before the transaction capability is ready", () => {
    const namespace = buildCodexAppMetaThreadToolSpecs()[0];
    const tools = namespace?.type === "namespace" ? namespace.tools : [];
    expect(tools.some((tool) => tool.name === "handoff_thread")).toBe(false);
    expect(tools.some((tool) => tool.name === "get_handoff_status")).toBe(false);
  });

  test("exposes only capability-checked cross-host destinations", () => {
    const namespace = buildCodexAppMetaThreadToolSpecs({
      handoffEnabled: true,
      crossHostHandoffEnabled: true,
      availableHandoffHosts: [
        { id: "local", displayName: "Local" },
        { id: "ssh:build", displayName: "Build Mac" },
      ],
    })[0];
    const handoff =
      namespace?.type === "namespace"
        ? namespace.tools.find((tool) => tool.name === "handoff_thread")
        : undefined;
    const destination = (
      handoff?.inputSchema as {
        properties?: { destinationHostId?: { enum?: string[]; description?: string } };
      }
    ).properties?.destinationHostId;

    expect(destination?.enum).toEqual(["local", "ssh:build"]);
    expect(destination?.description).toContain("Build Mac (ssh:build)");
  });

  test("wraps dynamic tool responses in app-server content items", () => {
    const success = buildCodexAppDynamicToolSuccess({ threadId: "thread-1" });
    const failure = buildCodexAppDynamicToolFailure("No Codex thread found");
    const successText =
      success.contentItems[0]?.type === "inputText" ? success.contentItems[0].text : null;
    const failureText =
      failure.contentItems[0]?.type === "inputText" ? failure.contentItems[0].text : null;

    expect(success.success).toBe(true);
    expect(success.contentItems[0]?.type).toBe("inputText");
    expect(successText).toBe('{"threadId":"thread-1"}');
    expect(failure.success).toBe(false);
    expect(failureText).toBe("No Codex thread found");
  });

  test("describes the live model and reasoning matrix in thread tool schemas", () => {
    const namespace = buildCodexAppMetaThreadToolSpecs({
      availableModels: [
        {
          model: "gpt-live",
          description: "Live model",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }],
        },
      ],
    })[0];
    const tools = namespace?.type === "namespace" ? namespace.tools : [];
    const createThread = tools.find((tool) => tool.name === "create_thread");
    const properties = (
      createThread?.inputSchema as
        | {
            properties?: Record<string, { description?: string }>;
          }
        | undefined
    )?.properties;
    const description = properties?.model?.description ?? "";

    expect(
      description.includes("gpt-live (Live model; supported reasoning efforts: medium, high)"),
    ).toBe(true);
    expect(
      description.includes("omit thinking unless its supported reasoning efforts are listed here"),
    ).toBe(true);
  });
});
