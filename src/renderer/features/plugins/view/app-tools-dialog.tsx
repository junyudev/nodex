import { useState, type CSSProperties } from "react";
import { ChevronDownMdIcon } from "@/components/shared/icons/customize-action-icons";
import {
  AppsGlyphIcon,
  ChatBubblesIcon16,
  ProfileLockIcon,
} from "@/components/shared/icons/plugin-detail-icons";
import { Badge } from "@/components/ui/badge";
import { NodexSwitch } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { ToolbarButton } from "@/components/ui/toolbar-button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { MarkdownRenderer } from "@/features/local-conversation/view/shared/markdown/markdown-renderer";
import { cn } from "@/lib/utils";
import type { PluginAppTool } from "../../../../shared/codex-plugin-settings";
import {
  appSwitchExplanation,
  appToolRestrictionLabel,
  appToolSections,
  appToolsSummary,
  appTryPrompt,
  type AppToolSection,
  type AppView,
} from "../model/app-model";
import { pluginMutationSucceeded } from "../model/mutation-result";
import { usePluginAppTools, usePluginManagement, type PluginContext } from "../plugin-management";
import { DetailDialog, DetailDialogTitle } from "./detail-dialog";
import { PluginLogoImage } from "./plugin-logo";

const MARKDOWN_STYLE = { "--markdown-font-size": "var(--text-base)" } as CSSProperties;

export interface AppEnabledToggle {
  readonly updatingAppId: string | null;
  readonly setEnabled: (app: AppView, enabled: boolean) => void;
}

/** Switches apps on and off one at a time, reporting the outcome. */
export function useAppEnabledToggle(context: PluginContext): AppEnabledToggle {
  const management = usePluginManagement(context);
  const [updatingAppId, setUpdatingAppId] = useState<string | null>(null);
  return {
    updatingAppId,
    setEnabled: (app, enabled) => {
      setUpdatingAppId(app.id);
      void management
        .setAppEnabled({ appId: app.id, enabled })
        .then((result) => {
          if (!pluginMutationSucceeded(result)) throw new Error(result.error.message);
          toast.success(enabled ? `${app.name} app enabled` : `${app.name} app disabled`);
        })
        .catch(() => toast.danger("Failed to update app"))
        .finally(() => setUpdatingAppId(null));
    },
  };
}

export function AppLogo({ app, className }: { readonly app: AppView; readonly className: string }) {
  return (
    <PluginLogoImage
      source={{ logoUrl: app.logoUrl, logoDarkUrl: app.logoDarkUrl, name: app.name }}
      className={cn("rounded-2xs", className)}
      fallback={<AppsGlyphIcon className="icon-sm text-(--color-text-secondary)" />}
    />
  );
}

/**
 * An app's switch. A locked or disabled app explains itself in the tooltip, and a locked switch
 * stays focusable so the explanation can be read.
 */
export function AppEnabledSwitch({
  app,
  toggle,
  className,
}: {
  readonly app: AppView;
  readonly toggle: AppEnabledToggle;
  readonly className?: string;
}) {
  const enabled = app.enabled && app.editable;
  const disabled = toggle.updatingAppId === app.id || !app.editable;
  const explanation = appSwitchExplanation(app);
  const label = enabled ? "Disable app" : "Enable app";
  const control = (
    <NodexSwitch
      ariaLabel="Enable app"
      className={className}
      checked={enabled}
      disabled={disabled}
      onCheckedChange={(next) => toggle.setEnabled(app, next)}
    />
  );
  return (
    <NodexTooltip tooltipContent={explanation ?? label} side="top">
      {disabled && explanation != null ? (
        <span
          role="switch"
          aria-checked={enabled}
          aria-disabled="true"
          aria-label="Enable app"
          tabIndex={0}
          className="flex items-center"
          onClick={(event) => event.stopPropagation()}
        >
          <span aria-hidden className="contents">
            {control}
          </span>
        </span>
      ) : (
        <span
          className="flex items-center"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {control}
        </span>
      )}
    </NodexTooltip>
  );
}

function ToolRow({ tool }: { readonly tool: PluginAppTool }) {
  const restriction = appToolRestrictionLabel(tool);
  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,220px)_minmax(0,1fr)] gap-x-3 p-2.5",
        restriction != null && "opacity-60",
      )}
    >
      <div className="min-w-0 text-token-foreground">
        <NodexTooltip tooltipContent={tool.name} side="top">
          <div className="truncate text-base">{tool.name}</div>
        </NodexTooltip>
        {restriction == null ? null : (
          <div className="mt-1 flex items-center gap-1 text-xs text-(--color-text-secondary)">
            {tool.disabledReason === "disabled_by_admin" ? (
              <ProfileLockIcon className="icon-xs shrink-0" />
            ) : null}
            {restriction}
          </div>
        )}
      </div>
      <div className="text-base text-(--color-text-secondary)">
        <MarkdownRenderer
          content={tool.description}
          style={MARKDOWN_STYLE}
          className="text-base [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
        />
      </div>
    </div>
  );
}

/** Write and Read sections; each header sticks while its tools scroll and folds them away. */
function ToolSections({ sections }: { readonly sections: readonly AppToolSection[] }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  return (
    <div className="flex flex-col">
      {sections.map((section) => {
        const isCollapsed = collapsed[section.title] === true;
        return (
          <div key={section.title} className="border-b border-(--color-border)/70 last:border-b-0">
            <button
              type="button"
              aria-expanded={!isCollapsed}
              className="sticky top-0 z-10 flex w-full cursor-interaction items-center justify-between bg-(--color-surface-secondary) p-2.5 text-start text-base text-token-foreground"
              onClick={() => setCollapsed({ ...collapsed, [section.title]: !isCollapsed })}
            >
              <span>
                {section.title}
                <span className="ms-2 text-tertiary">{section.tools.length}</span>
              </span>
              <ChevronDownMdIcon
                className={cn(
                  "icon-xs shrink-0 text-tertiary transition-transform",
                  isCollapsed && "-rotate-90",
                )}
              />
            </button>
            {isCollapsed ? null : (
              <div className="divide-y divide-(--color-border)/70">
                {section.tools.map((tool) => (
                  <ToolRow key={tool.name} tool={tool} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ToolsBody({ context, app }: { readonly context: PluginContext; readonly app: AppView }) {
  const tools = usePluginAppTools(context, app.id);
  const sections = appToolSections(tools.data?.tools ?? []);
  const error = tools.error?.message ?? tools.data?.error?.message ?? null;
  let content;
  if (tools.isPending) {
    content = "Loading tools…";
  } else if (error != null) {
    content = (
      <div>
        <div>Unable to load tools for this app.</div>
        <div>{error}</div>
      </div>
    );
  } else if (sections.length === 0) {
    content = "No tools available for this app.";
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      {sections.length > 0 ? (
        <div className="shrink-0 text-base text-(--color-text-secondary)">
          {appToolsSummary(app.name, sections)}
        </div>
      ) : null}
      <div className="flex h-full min-h-0 flex-1 flex-col pt-4">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-(--color-border)/70">
          <div className="h-full min-h-0 overflow-y-auto">
            {content == null ? (
              <ToolSections sections={sections} />
            ) : (
              <div className="flex h-full min-h-32 items-center justify-center text-base text-(--color-text-secondary)">
                {content}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The tools an app gives Agents, split into tools that change things and tools that only
 * read. Its switch sits beside the close button, and Try now starts a chat that mentions it.
 */
export function AppToolsDialog({
  context,
  app: selected,
  toggle,
  showEnableToggle = true,
  onOpenChange,
  onStartChat,
}: {
  readonly context: PluginContext;
  /** The app to show; the dialog is open while it is set. */
  readonly app: AppView | null;
  readonly toggle: AppEnabledToggle;
  readonly showEnableToggle?: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onStartChat: (prompt: string) => void;
}) {
  // The last app stays on screen while the dialog closes.
  const [shown, setShown] = useState(selected);
  if (selected != null && selected !== shown) setShown(selected);
  const app = selected ?? shown;
  const enabled = app?.enabled === true && app.editable;
  const canTry = app?.accessible === true && app.enabled;
  const explanation = app == null ? null : appSwitchExplanation(app);
  return (
    <DetailDialog
      open={selected != null}
      onOpenChange={onOpenChange}
      size="wide"
      icon={app == null ? null : <AppLogo app={app} className="icon-md" />}
      title={
        <DetailDialogTitle
          title={app?.name ?? ""}
          kind="App"
          badge={
            app?.accessible === true && !enabled ? <Badge variant="outline">Disabled</Badge> : null
          }
        />
      }
      titleText={app?.name ?? ""}
      description={app?.description ?? "Tools for this app"}
      headerActions={
        app != null && showEnableToggle && (app.accessible || !app.enabled) ? (
          <AppEnabledSwitch app={app} toggle={toggle} className="h-token-button-composer" />
        ) : null
      }
      footer={
        app == null ? null : (
          <div className="flex w-full items-center justify-end gap-2">
            <NodexTooltip
              tooltipContent={
                canTry ? null : (explanation ?? "Enable and connect this app to try it now")
              }
              side="top"
            >
              <span className="flex">
                <ToolbarButton
                  color="primary"
                  disabled={!canTry}
                  onClick={() => onStartChat(appTryPrompt(app))}
                >
                  <ChatBubblesIcon16 />
                  Try now
                </ToolbarButton>
              </span>
            </NodexTooltip>
          </div>
        )
      }
    >
      {app == null ? null : <ToolsBody context={context} app={app} />}
    </DetailDialog>
  );
}
