import { AppActivityIcon, SettingsGeneralIcon, StopIcon } from "@/components/shared/icons";
import { Sparkles } from "@/components/shared/icons/generic-icons";
import { cloneElement, useEffect, useState, type ReactElement, type ReactNode } from "react";
import type {
  CodexCommandAction,
  CodexMcpServerElicitationRequest,
  CodexTranscriptEntry,
  ProtocolAppInfo,
} from "../../../../../lib/types";
import { resolveCodexMcpVisualSource } from "../../../../../../shared/codex-mcp-tool-call";
import { extractCommandActions } from "../../../projection/tool-metadata/command-actions";
import {
  isCurlWebSearchCommand,
  resolveConversationCommandText,
} from "../../../projection/tool-metadata/command-activity-classification";
import { getDynamicToolRegistryEntry } from "../../../projection/tool-metadata/dynamic-tool-call-utils";
import { resolveNodexDynamicToolCallPresentation } from "../../../projection/tool-metadata/nodex-dynamic-tool-call-presentation";
import { resolveThreadVisualizationCommandKind } from "../../../projection/agent-activity-v2";
import { normalizeEnvironmentAwareAppResourceSource } from "../../../../../lib/app-resource-source";
import { useTheme } from "../../../../../lib/use-theme";
import { cn } from "../../../../../lib/utils";
import type { ThreadBlockModel } from "../../../thread-stage-types";
import {
  AutomaticApprovalReviewIcon,
  ActivityListFilesIcon,
  ActivitySearchIcon,
  BrowserUseIcon,
  SuccessCircleIcon,
  ComputerUseIcon,
  ConnectorFallbackIcon,
  EditFilesIcon,
  ConnectorGlobeIcon,
  HooksIcon,
  PluginCubeIcon,
  ReadFilesIcon,
  SkillIcon,
  TerminalActivityIcon,
  DeniedCircleIcon,
  withActivityIconClass,
} from "@/components/shared/icons";

export type ToolActivityIconId =
  | "app"
  | "approved"
  | "automatic-review"
  | "browser-use"
  | "code-searching"
  | "computer-use"
  | "connector"
  | "denied"
  | "edit-files"
  | "hooks"
  | "list-files"
  | "node-repl"
  | "plugin"
  | "read-files"
  | "run-command"
  | "settings"
  | "skill"
  | "stopped"
  | "visualization"
  | "web-search";

export type ToolActivityIconDescriptor =
  | {
      kind: "semantic";
      icon: ToolActivityIconId;
    }
  | {
      kind: "logo";
      alt: string;
      logoUrl: string | null;
      logoDarkUrl?: string | null;
      fallbackIcon: ToolActivityIconId;
    };

const ACTIVITY_ICON_CLASS_NAME = "icon-xs shrink-0 text-token-conversation-body";
const SOURCE_ICON_CLASS_NAME =
  "icon-xs shrink-0 rounded-2xs bg-token-main-surface-primary object-contain text-token-text-secondary";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function pickFirstString(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function SemanticToolIcon({ icon, className }: { icon: ToolActivityIconId; className?: string }) {
  const iconClassName = withActivityIconClass(ACTIVITY_ICON_CLASS_NAME, className);
  switch (icon) {
    case "app":
      return <AppActivityIcon aria-hidden className={iconClassName} />;
    case "approved":
      return <SuccessCircleIcon aria-hidden className={iconClassName} />;
    case "automatic-review":
      return <AutomaticApprovalReviewIcon aria-hidden className={iconClassName} />;
    case "browser-use":
      return <BrowserUseIcon aria-hidden className={iconClassName} />;
    case "computer-use":
      return <ComputerUseIcon aria-hidden className={iconClassName} />;
    case "connector":
      return <ConnectorFallbackIcon aria-hidden className={iconClassName} />;
    case "code-searching":
      return <ActivitySearchIcon aria-hidden className={iconClassName} />;
    case "denied":
      return <DeniedCircleIcon aria-hidden className={iconClassName} />;
    case "edit-files":
      return <EditFilesIcon aria-hidden className={iconClassName} />;
    case "hooks":
      return <HooksIcon aria-hidden className={iconClassName} />;
    case "list-files":
      return <ActivityListFilesIcon aria-hidden className={iconClassName} />;
    case "node-repl":
      return <TerminalActivityIcon aria-hidden className={iconClassName} />;
    case "plugin":
      return <PluginCubeIcon aria-hidden className={iconClassName} />;
    case "read-files":
      return <ReadFilesIcon aria-hidden className={iconClassName} />;
    case "settings":
      return <SettingsGeneralIcon className={iconClassName} />;
    case "skill":
      return <SkillIcon aria-hidden className={iconClassName} />;
    case "stopped":
      return <StopIcon aria-hidden className={iconClassName} />;
    case "visualization":
      return <Sparkles aria-hidden className={iconClassName} />;
    case "web-search":
      return <ConnectorGlobeIcon aria-hidden className={iconClassName} />;
    case "run-command":
      return <TerminalActivityIcon aria-hidden className={iconClassName} />;
  }
}

function LogoImageWithFallback({
  alt,
  className,
  fallback,
  src,
}: {
  alt: string;
  className: string;
  fallback: ReactNode;
  src: string;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (failed) return fallback;

  return (
    <img
      alt={alt}
      className={className}
      src={src}
      onError={() => {
        setFailed(true);
      }}
    />
  );
}

export function selectConnectorLogoUrl({
  isDarkTheme,
  logoDarkUrl,
  logoUrl,
}: {
  isDarkTheme: boolean;
  logoDarkUrl?: string | null;
  logoUrl?: string | null;
}): string | null {
  const lightLogo = logoUrl?.trim() || null;
  const darkLogo = logoDarkUrl?.trim() || null;
  return isDarkTheme ? (darkLogo ?? lightLogo) : (lightLogo ?? darkLogo);
}

export function ConnectorLogo({
  alt,
  className,
  fallback,
  logoDarkUrl,
  logoUrl,
}: {
  alt: string;
  className?: string;
  fallback: ReactElement<{ className?: string }>;
  logoDarkUrl?: string | null;
  logoUrl?: string | null;
}) {
  const { resolved } = useTheme();
  const mergedClassName = cn("rounded-2xs", className);
  const src = normalizeEnvironmentAwareAppResourceSource(
    selectConnectorLogoUrl({
      isDarkTheme: resolved === "dark",
      logoDarkUrl,
      logoUrl,
    }),
    globalThis.location?.protocol ?? "app:",
  );
  const fallbackElement = cloneElement(fallback, {
    className: cn(mergedClassName, fallback.props.className),
  });

  if (!src) return fallbackElement;

  return (
    <LogoImageWithFallback
      alt={alt}
      className={mergedClassName}
      src={src}
      fallback={fallbackElement}
    />
  );
}

export function ToolActivityIcon({
  className,
  descriptor,
}: {
  className?: string;
  descriptor: ToolActivityIconDescriptor;
}) {
  if (descriptor.kind === "semantic") {
    return (
      <span data-tool-activity-icon={descriptor.icon} className="inline-flex shrink-0">
        <SemanticToolIcon icon={descriptor.icon} className={className} />
      </span>
    );
  }

  return (
    <span
      data-tool-activity-icon="logo"
      data-tool-source-icon={descriptor.alt}
      className="inline-flex shrink-0"
    >
      <ConnectorLogo
        alt={descriptor.alt}
        className={withActivityIconClass(SOURCE_ICON_CLASS_NAME, className)}
        logoUrl={descriptor.logoUrl}
        logoDarkUrl={descriptor.logoDarkUrl}
        fallback={<SemanticToolIcon icon={descriptor.fallbackIcon} className={className} />}
      />
    </span>
  );
}

export function semanticToolIcon(icon: ToolActivityIconId): ToolActivityIconDescriptor {
  return { kind: "semantic", icon };
}

export function resolveExplorationActionIcon(action: CodexCommandAction): ToolActivityIconId {
  if (action.type === "search") return "code-searching";
  if (action.type === "listFiles") return "list-files";
  if (
    action.type === "read" &&
    /(^|[/\\])(?:SKILL\.md|skills?)(?:$|[/\\])/iu.test(action.path || action.name || "")
  ) {
    return "skill";
  }
  if (action.type === "read") return "read-files";
  return "run-command";
}

export function resolveWebSearchIcon(): ToolActivityIconDescriptor {
  return semanticToolIcon("web-search");
}

function extractLogoMetadata(value: unknown): {
  logoUrl: string | null;
  logoDarkUrl: string | null;
  nativeIconPath: string | null;
} {
  const record = asRecord(value);
  if (!record) return { logoUrl: null, logoDarkUrl: null, nativeIconPath: null };

  const nestedSources = [
    record,
    asRecord(record.source),
    asRecord(record.server),
    asRecord(record.app),
    asRecord(record.connector),
    asRecord(record.plugin),
    asRecord(record.meta),
    asRecord(record.metadata),
  ].filter((entry): entry is Record<string, unknown> => Boolean(entry));

  for (const candidate of nestedSources) {
    const logoUrl = pickFirstString(
      candidate.logoUrl,
      candidate.logo_url,
      candidate.logoPath,
      candidate.logo_path,
    );
    const logoDarkUrl = pickFirstString(
      candidate.logoDarkUrl,
      candidate.logoUrlDark,
      candidate.logo_url_dark,
      candidate.logoDarkURL,
    );
    const nativeIconPath = pickFirstString(
      candidate.nativeAppIconPath,
      candidate.appIconPath,
      candidate.iconPath,
    );
    if (logoUrl || logoDarkUrl || nativeIconPath) {
      return { logoUrl, logoDarkUrl, nativeIconPath };
    }
  }

  return { logoUrl: null, logoDarkUrl: null, nativeIconPath: null };
}

export function resolveMcpSourceIcon(
  item: CodexTranscriptEntry,
  resolvedApps: readonly ProtocolAppInfo[] = [],
): ToolActivityIconDescriptor {
  const payload = item.mcpToolCall;
  if (!payload) return semanticToolIcon("connector");
  const source = resolveCodexMcpVisualSource({
    functionName: payload.functionName,
    invocation: payload.invocation,
    resolvedApps,
    source: payload.source,
  });
  if (!source) return semanticToolIcon("connector");

  const fallbackIcon: ToolActivityIconId =
    source.key === "browser-use"
      ? "browser-use"
      : source.key === "computer-use" || source.key.startsWith("native-app:")
        ? "computer-use"
        : source.key === "server:node_repl"
          ? "node-repl"
          : "connector";
  if (source.logoUrl || source.logoUrlDark) {
    return {
      kind: "logo",
      alt: `${source.name} logo`,
      logoUrl: source.logoUrl,
      logoDarkUrl: source.logoUrlDark,
      fallbackIcon,
    };
  }
  return semanticToolIcon(fallbackIcon);
}

export function resolveMcpElicitationIcon(
  request: CodexMcpServerElicitationRequest,
): ToolActivityIconDescriptor {
  const metaLogo = extractLogoMetadata(request.meta);
  const normalizedServer = request.serverName.trim().toLowerCase();
  if (metaLogo.logoUrl || metaLogo.logoDarkUrl || metaLogo.nativeIconPath) {
    return {
      kind: "logo",
      alt: `${request.serverName} logo`,
      logoUrl: metaLogo.nativeIconPath ?? metaLogo.logoUrl,
      logoDarkUrl: metaLogo.logoDarkUrl,
      fallbackIcon: request.kind === "toolSuggestion" ? "plugin" : "connector",
    };
  }
  if (normalizedServer.includes("browser-use")) return semanticToolIcon("browser-use");
  if (normalizedServer.includes("computer-use") || normalizedServer.includes("computer use")) {
    return semanticToolIcon("computer-use");
  }
  return semanticToolIcon(request.kind === "toolSuggestion" ? "plugin" : "connector");
}

export function resolveApprovalIcon(status: string | undefined): ToolActivityIconDescriptor | null {
  if (status === "approved") return semanticToolIcon("approved");
  if (status === "denied" || status === "aborted" || status === "declined" || status === "failed") {
    return semanticToolIcon("denied");
  }
  return null;
}

export function resolveToolActivityEntryIcon(
  block: Extract<ThreadBlockModel, { type: "agentActivityGroup" }>["entries"][number],
  resolvedApps: readonly ProtocolAppInfo[],
): ToolActivityIconDescriptor | null {
  if (block.type === "webSearch") return resolveWebSearchIcon();
  if (block.type === "fileChange") return semanticToolIcon("edit-files");
  if (block.type === "exec") {
    const actions = extractCommandActions(block.entry);
    const explorationAction = actions.findLast(
      (action) => action.type === "read" || action.type === "search" || action.type === "listFiles",
    );
    if (explorationAction) return semanticToolIcon(resolveExplorationActionIcon(explorationAction));

    if (block.entry.executionStatus === "interrupted" || block.status === "interrupted") {
      return semanticToolIcon("stopped");
    }

    const command = resolveConversationCommandText(block.entry);
    if (command && isCurlWebSearchCommand(command)) return resolveWebSearchIcon();
    if (command && resolveThreadVisualizationCommandKind(command) != null) {
      return semanticToolIcon("visualization");
    }
    return semanticToolIcon("run-command");
  }
  if (block.type === "automaticApprovalReview") return semanticToolIcon("automatic-review");
  if (block.type === "hook") return semanticToolIcon("hooks");
  if (block.type === "mcpToolCall") return resolveMcpSourceIcon(block.entry, resolvedApps);
  if (block.type === "dynamicToolCall") {
    const call = block.entry.dynamicToolCall;
    if (!call) return null;

    const nodexPresentation = resolveNodexDynamicToolCallPresentation(call);
    switch (nodexPresentation?.icon) {
      case "read":
        return semanticToolIcon("list-files");
      case "search":
        return semanticToolIcon("code-searching");
      case "transfer":
      case "write":
        return semanticToolIcon("edit-files");
      case "database":
        return semanticToolIcon("settings");
    }

    const registryEntry = getDynamicToolRegistryEntry(call);
    if (
      registryEntry?.rendererKind === "settings" ||
      registryEntry?.rendererKind === "automationUpdate"
    ) {
      return semanticToolIcon("settings");
    }
    if (registryEntry?.rendererKind === "chromeTabContext") return resolveWebSearchIcon();
    if (call.namespace === "codex_app") return semanticToolIcon("app");
    return semanticToolIcon("plugin");
  }
  return null;
}

export const toolCallIconTestHelpers = {
  resolveApprovalIcon,
  resolveExplorationActionIcon,
  selectConnectorLogoUrl,
};
