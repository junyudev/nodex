import { describe, expect, test } from "vite-plus/test";
import { fireEvent } from "@testing-library/react";
import { renderWithMaitai as render } from "../../../../../test/thread-maitai";
import type {
  CodexConversationItem,
  CodexMcpServerElicitationRequest,
  CodexTranscriptEntry,
  ProtocolAppInfo,
} from "../../../../../lib/types";
import {
  ConnectorLogo,
  ToolActivityIcon,
  resolveMcpElicitationIcon,
  resolveMcpSourceIcon,
  resolveToolActivityEntryIcon,
  resolveWebSearchIcon,
  semanticToolIcon,
  toolCallIconTestHelpers,
} from "./tool-call-icons";
import { ConnectorFallbackIcon } from "@/components/shared/icons";

function buildEntry(overrides: Partial<CodexTranscriptEntry>): CodexTranscriptEntry {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    entryId: "item-1",
    type: "tool",
    kind: "toolCall",
    semanticKind: "exec",
    status: "completed",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function buildApp(id: string, name: string, logoUrl: string): ProtocolAppInfo {
  return {
    id,
    name,
    description: null,
    logoUrl,
    logoUrlDark: null,
    iconAssets: null,
    iconDarkAssets: null,
    distributionChannel: null,
    branding: null,
    appMetadata: null,
    labels: null,
    installUrl: null,
    isAccessible: true,
    isEnabled: true,
    pluginDisplayNames: [],
  };
}

describe("tool-call icon helpers", () => {
  test("maps semantic tool icons to decorative SVG wrappers", () => {
    const { container } = render(<ToolActivityIcon descriptor={semanticToolIcon("run-command")} />);
    const wrapper = container.querySelector("[data-tool-activity-icon='run-command']");
    const svg = wrapper?.querySelector("svg");

    expect(Boolean(wrapper)).toBe(true);
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });

  test("maps typed exploration actions to semantic activity icons", () => {
    expect(
      toolCallIconTestHelpers.resolveExplorationActionIcon({
        type: "read",
        command: "sed -n '1,80p' src/app.ts",
        path: "src/app.ts",
        name: "app.ts",
      }),
    ).toBe("read-files");
    expect(
      toolCallIconTestHelpers.resolveExplorationActionIcon({
        type: "search",
        command: "rg activity src",
        query: "activity",
        path: "src",
      }),
    ).toBe("code-searching");
    expect(
      toolCallIconTestHelpers.resolveExplorationActionIcon({
        type: "listFiles",
        command: "ls src",
        path: "src",
      }),
    ).toBe("list-files");
    expect(
      toolCallIconTestHelpers.resolveExplorationActionIcon({
        type: "read",
        command: "sed -n '1,80p' .agents/skills/ui/SKILL.md",
        path: ".agents/skills/ui/SKILL.md",
        name: "SKILL.md",
      }),
    ).toBe("skill");
  });

  test("uses theme-specific connector logo URLs and falls back on image failure", () => {
    expect(
      toolCallIconTestHelpers.selectConnectorLogoUrl({
        isDarkTheme: true,
        logoUrl: "https://example.com/light.svg",
        logoDarkUrl: "https://example.com/dark.svg",
      }),
    ).toBe("https://example.com/dark.svg");

    const { container } = render(
      <ConnectorLogo
        alt="Example logo"
        className="icon-xs object-contain"
        logoUrl="https://example.com/light.svg"
        logoDarkUrl={null}
        fallback={<ConnectorFallbackIcon aria-hidden className="icon-xs" />}
      />,
    );

    const image = container.querySelector("img");
    expect(image?.getAttribute("alt")).toBe("Example logo");
    fireEvent.error(image as HTMLImageElement);
    expect(Boolean(container.querySelector("img"))).toBe(false);
    expect(Boolean(container.querySelector("svg"))).toBe(true);
  });

  test("resolves MCP source and elicitation metadata logos", () => {
    const mcpEntry = buildEntry({
      semanticKind: "mcpToolCall",
      toolCall: {
        subtype: "mcp",
        server: "browser-use",
        toolName: "open",
      },
      mcpToolCall: {
        callId: "call-1",
        functionName: "browser-use__open",
        pluginId: null,
        readOnlyHint: true,
        mcpAppResourceUri: undefined,
        source: null,
        invocation: {
          server: "browser-use",
          tool: "open",
          arguments: {},
        },
        durationMs: null,
        completed: true,
        result: null,
      },
    });
    const elicitationRequest: CodexMcpServerElicitationRequest = {
      type: "mcpServerElicitation",
      requestId: "req-1",
      projectId: null,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      kind: "toolSuggestion",
      mode: "url",
      serverName: "Linear",
      message: "Install Linear",
      meta: {
        logoUrl: "https://example.com/linear.svg",
        logoDarkUrl: "https://example.com/linear-dark.svg",
      },
      createdAt: 1,
    };

    const mcpIcon = resolveMcpSourceIcon(mcpEntry, [
      buildApp("connector_browser_use", "Browser Use", "https://example.com/browser.svg"),
    ]);
    const elicitationIcon = resolveMcpElicitationIcon(elicitationRequest);
    expect(mcpIcon.kind).toBe("logo");
    expect(mcpIcon.kind === "logo" ? mcpIcon.logoUrl : "").toBe("https://example.com/browser.svg");
    expect(elicitationIcon.kind).toBe("logo");
    expect(elicitationIcon.kind === "logo" ? elicitationIcon.fallbackIcon : "").toBe("plugin");
  });

  test("uses canonical MCP source and node-repl icon identities", () => {
    const browserEntry = buildEntry({
      semanticKind: "mcpToolCall",
      mcpToolCall: {
        callId: "browser-call",
        functionName: "node_repl__browser",
        pluginId: null,
        readOnlyHint: false,
        mcpAppResourceUri: undefined,
        source: { kind: "browserUse", backend: "iab" },
        invocation: { server: "node_repl", tool: "browser", arguments: {} },
        durationMs: null,
        completed: true,
        result: null,
      },
    });
    const computerEntry = buildEntry({
      semanticKind: "mcpToolCall",
      mcpToolCall: {
        callId: "computer-call",
        functionName: "node_repl__computer",
        pluginId: null,
        readOnlyHint: false,
        mcpAppResourceUri: undefined,
        source: { kind: "computerUse", app: null },
        invocation: { server: "node_repl", tool: "computer", arguments: {} },
        durationMs: null,
        completed: true,
        result: null,
      },
    });
    const nodeEntry = buildEntry({
      semanticKind: "mcpToolCall",
      mcpToolCall: {
        callId: "node-call",
        functionName: "node_repl__js",
        pluginId: null,
        readOnlyHint: null,
        mcpAppResourceUri: undefined,
        source: null,
        invocation: { server: "node_repl", tool: "js", arguments: {} },
        durationMs: null,
        completed: true,
        result: null,
      },
    });

    const browserIcon = resolveMcpSourceIcon(browserEntry);
    const computerIcon = resolveMcpSourceIcon(computerEntry);
    const nodeIcon = resolveMcpSourceIcon(nodeEntry);
    expect(browserIcon.kind === "semantic" ? browserIcon.icon : "").toBe("browser-use");
    expect(computerIcon.kind === "semantic" ? computerIcon.icon : "").toBe("computer-use");
    expect(nodeIcon.kind === "semantic" ? nodeIcon.icon : "").toBe("node-repl");
  });

  test("resolves group header icons from the exact activity item family", () => {
    const commandEntry = buildEntry({
      semanticKind: "exec",
      commandActions: [
        {
          type: "search",
          command: "rg ToolActivityIcon",
          query: "ToolActivityIcon",
          path: "src",
        },
      ],
    }) as CodexConversationItem;
    const webEntry = buildEntry({
      semanticKind: "webSearch",
      rawItem: {
        action: {
          type: "openPage",
          url: "https://storybook.js.org/docs",
        },
      },
    }) as CodexConversationItem;

    const commandDescriptor = resolveToolActivityEntryIcon(
      {
        id: "command",
        turnId: "turn-1",
        createdAt: 1,
        updatedAt: 1,
        searchableText: "Explored",
        type: "exec",
        entry: commandEntry,
        status: "completed",
      },
      [],
    );
    const webDescriptor = resolveToolActivityEntryIcon(
      {
        id: "web",
        turnId: "turn-1",
        createdAt: 1,
        updatedAt: 1,
        searchableText: "Web",
        type: "webSearch",
        entry: webEntry,
      },
      [],
    );

    expect(commandDescriptor?.kind === "semantic" ? commandDescriptor.icon : "").toBe(
      "code-searching",
    );
    expect(webDescriptor?.kind === "semantic" ? webDescriptor.icon : "").toBe("web-search");
  });

  test("uses semantic command evidence for stopped, web, and visualization activity", () => {
    const makeCommandBlock = (entry: CodexConversationItem) => ({
      id: entry.itemId,
      turnId: "turn-1",
      createdAt: 1,
      updatedAt: 1,
      searchableText: "command",
      type: "exec" as const,
      entry,
      status: entry.status,
    });
    const stopped = resolveToolActivityEntryIcon(
      makeCommandBlock(
        buildEntry({
          itemId: "stopped",
          semanticKind: "exec",
          status: "interrupted",
          executionStatus: "interrupted",
          command: "pnpm test",
        }) as CodexConversationItem,
      ),
      [],
    );
    const web = resolveToolActivityEntryIcon(
      makeCommandBlock(
        buildEntry({
          itemId: "curl",
          semanticKind: "exec",
          command: "curl https://example.com",
        }) as CodexConversationItem,
      ),
      [],
    );
    const visualization = resolveToolActivityEntryIcon(
      makeCommandBlock(
        buildEntry({
          itemId: "visualization",
          semanticKind: "exec",
          command: "mkdir -p /tmp/visualizations/chart",
        }) as CodexConversationItem,
      ),
      [],
    );

    expect(stopped?.kind === "semantic" ? stopped.icon : "").toBe("stopped");
    expect(web?.kind === "semantic" ? web.icon : "").toBe("web-search");
    expect(visualization?.kind === "semantic" ? visualization.icon : "").toBe("visualization");
  });

  test("uses the automatic-review semantic icon for grouped review activity", () => {
    const entry = buildEntry({
      semanticKind: "automaticApprovalReview",
      status: "inProgress",
      rawItem: { review: { status: "inProgress" } },
    }) as CodexConversationItem;
    const descriptor = resolveToolActivityEntryIcon(
      {
        id: "review",
        turnId: "turn-1",
        createdAt: 1,
        updatedAt: 1,
        searchableText: "Auto-reviewing",
        type: "automaticApprovalReview",
        entry,
        status: "inProgress",
      },
      [],
    );

    expect(descriptor?.kind).toBe("semantic");
    expect(descriptor?.kind === "semantic" ? descriptor.icon : "").toBe("automatic-review");
  });

  test("web search row resolver falls back to the semantic globe", () => {
    const descriptor = resolveWebSearchIcon();

    expect(descriptor.kind === "semantic" ? descriptor.icon : "").toBe("web-search");
  });
});
