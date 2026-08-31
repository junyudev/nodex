import { describe, expect, test, vi } from "vite-plus/test";
import { fireEvent } from "@testing-library/react";
import type { HookMetadata } from "@nodex/codex-app-server-protocol/v2/HookMetadata";
import type { HooksListEntry } from "@nodex/codex-app-server-protocol/v2/HooksListEntry";
import { render } from "../../test/dom";
import { CodexHooksSettingsView } from "./workbench-hooks-settings-page";

type CommandHookMetadata = Extract<HookMetadata, { handlerType: "command" }>;

function hook(
  overrides: Partial<CommandHookMetadata> & Pick<CommandHookMetadata, "key" | "source">,
): CommandHookMetadata {
  return {
    eventName: "stop",
    handlerType: "command",
    matcher: null,
    command: "echo done",
    async: false,
    timeoutSec: 10n,
    statusMessage: null,
    sourcePath: "/workspace/nodex/.codex/hooks.json",
    pluginId: null,
    displayOrder: 0n,
    enabled: true,
    isManaged: false,
    currentHash: "hash",
    trustStatus: "trusted",
    ...overrides,
    additionalContextLimit: overrides.additionalContextLimit ?? null,
  };
}

function renderView(input?: {
  entries?: HooksListEntry[];
  path?: string;
  onPathChange?: (path: string) => void;
  onToggle?: (hook: HookMetadata, enabled: boolean) => void;
  onTrust?: (hook: HookMetadata) => void;
}) {
  return render(
    <CodexHooksSettingsView
      entries={input?.entries ?? []}
      hostId="default"
      path={input?.path ?? "/settings/hooks-settings?hostId=default"}
      projectRoots={["/workspace/nodex"]}
      projectRootLabels={{ "/workspace/nodex": "Nodex" }}
      loading={false}
      refreshing={false}
      loadError={null}
      onPathChange={input?.onPathChange ?? (() => undefined)}
      onRefresh={() => undefined}
      onToggle={input?.onToggle ?? (() => undefined)}
      onTrust={input?.onTrust ?? (() => undefined)}
    />,
  );
}

describe("Hooks settings", () => {
  test("routes a project source row to the exact selected detail path", () => {
    const onPathChange = vi.fn();
    const { getByText } = renderView({
      entries: [
        {
          cwd: "/workspace/nodex",
          hooks: [hook({ key: "project-hook", source: "project" })],
          warnings: [],
          errors: [],
        },
      ],
      onPathChange,
    });

    fireEvent.click(getByText("Nodex"));
    expect(onPathChange).toHaveBeenCalledWith(
      "/settings/hooks-settings?hostId=default&source=project&projectRoot=%2Fworkspace%2Fnodex",
    );
  });

  test("enforces managed, review-needed, and trusted mutation boundaries", () => {
    const onToggle = vi.fn();
    const onTrust = vi.fn();
    const trusted = hook({ key: "trusted", source: "user", enabled: false, displayOrder: 0n });
    const untrusted = hook({
      key: "untrusted",
      source: "user",
      trustStatus: "untrusted",
      displayOrder: 1n,
    });
    const managed = hook({
      key: "managed",
      source: "user",
      enabled: false,
      isManaged: true,
      trustStatus: "managed",
      displayOrder: 2n,
    });
    const { getByText, getAllByRole } = renderView({
      entries: [
        {
          cwd: "/workspace/nodex",
          hooks: [trusted, untrusted, managed],
          warnings: ["Review config"],
          errors: [],
        },
      ],
      path: "/settings/hooks-settings?hostId=default&source=user",
      onToggle,
      onTrust,
    });

    const switches = getAllByRole("switch") as HTMLButtonElement[];
    expect(switches).toHaveLength(3);
    expect(switches[0]?.disabled).toBe(false);
    expect(switches[1]?.disabled).toBe(true);
    expect(switches[2]?.disabled).toBe(true);
    expect(switches[2]?.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(switches[0] as HTMLButtonElement);
    expect(onToggle).toHaveBeenCalledWith(trusted, true);
    fireEvent.click(getByText("Trust"));
    expect(onTrust).toHaveBeenCalledWith(untrusted);
    expect(
      getByText(
        "Hooks can run outside of the sandbox so we ask you to review any recently installed or modified hooks",
      ),
    ).toBeTruthy();
  });

  test("shows MCP tool handler identity in hook details", () => {
    const mcpHook: HookMetadata = {
      key: "mcp-tool",
      eventName: "postToolUse",
      handlerType: "mcpTool",
      server: "filesystem",
      tool: "read_file",
      matcher: null,
      timeoutSec: 10n,
      statusMessage: null,
      source: "user",
      sourcePath: "/workspace/nodex/.codex/hooks.json",
      pluginId: null,
      displayOrder: 0n,
      enabled: true,
      isManaged: false,
      currentHash: "hash",
      trustStatus: "trusted",
      additionalContextLimit: null,
    };
    const { getByText } = renderView({
      entries: [{ cwd: "/workspace/nodex", hooks: [mcpHook], warnings: [], errors: [] }],
      path: "/settings/hooks-settings?hostId=default&source=user",
    });

    fireEvent.click(getByText("Hook 1"));
    expect(getByText("MCP tool")).toBeTruthy();
    expect(getByText("filesystem")).toBeTruthy();
    expect(getByText("read_file")).toBeTruthy();
  });

  test("labels interrupt hooks with their turn lifecycle semantics", () => {
    const { getByText } = renderView({
      entries: [
        {
          cwd: "/workspace/nodex",
          hooks: [hook({ key: "interrupt", source: "user", eventName: "interrupt" })],
          warnings: [],
          errors: [],
        },
      ],
      path: "/settings/hooks-settings?hostId=default&source=user",
    });

    expect(getByText("Interrupt")).toBeTruthy();
    expect(getByText("When a turn is interrupted")).toBeTruthy();
  });
});
