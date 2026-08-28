import { useState, type ReactNode } from "react";
import {
  CheckmarkIcon,
  ChevronDownIcon,
  CopyIcon,
  LocalEnvironmentActionIcon,
} from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { LazySourceViewer } from "@/components/ui/lazy-source-viewer";
import { writeTextToClipboard } from "@/lib/clipboard";
import type {
  WorktreeEnvironmentDefinition,
  WorktreeEnvironmentPlatform,
  WorktreeEnvironmentScriptDefinition,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { LocalEnvironmentVariablesPopover } from "./local-environment-variables-popover";

type LifecyclePlatform = "default" | WorktreeEnvironmentPlatform;

const LIFECYCLE_PLATFORM_OPTIONS: ReadonlyArray<{
  value: LifecyclePlatform;
  label: string;
}> = [
  { value: "default", label: "Default" },
  { value: "darwin", label: "macOS" },
  { value: "linux", label: "Linux" },
  { value: "win32", label: "Windows" },
];

function PlatformSelector({
  label,
  value,
  onChange,
}: {
  label: string;
  value: LifecyclePlatform;
  onChange: (value: LifecyclePlatform) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={label}>
      {LIFECYCLE_PLATFORM_OPTIONS.map((option) => (
        <NodexButton
          key={option.value}
          size="composer"
          variant={value === option.value ? "secondary" : "ghost"}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </NodexButton>
      ))}
    </div>
  );
}

function LocalEnvironmentScriptPreview({
  script,
  language,
  ariaLabel,
}: {
  script: string;
  language: "bash" | "text";
  ariaLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex max-h-56 min-h-20 flex-col overflow-auto rounded-lg border-[0.5px] border-token-border bg-token-input-background">
      <div className="flex shrink-0 items-center justify-between px-3 pt-2">
        <span className="font-mono text-xs text-token-text-secondary">{language}</span>
        <NodexButton
          size="icon-xs"
          variant="ghost"
          aria-label={copied ? "Copied" : "Copy script"}
          onClick={() => {
            void writeTextToClipboard(script).then((didCopy) => {
              if (!didCopy) return;
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1_200);
            });
          }}
        >
          {copied ? <CheckmarkIcon className="icon-xs" /> : <CopyIcon className="icon-xs" />}
        </NodexButton>
      </div>
      <LazySourceViewer
        value={script}
        language={language}
        ariaLabel={ariaLabel}
        wrap
        className="min-h-16"
      />
    </div>
  );
}

function hasLifecycleScript(definition: WorktreeEnvironmentScriptDefinition): boolean {
  return Boolean(definition.script) || Object.values(definition.platformScripts).some(Boolean);
}

function LifecycleSummary({
  title,
  description,
  definition,
  action,
}: {
  title: string;
  description: string;
  definition: WorktreeEnvironmentScriptDefinition;
  action?: ReactNode;
}) {
  const [platform, setPlatform] = useState<LifecyclePlatform>("default");
  const hasAnyScript = hasLifecycleScript(definition);
  const defaultScript = definition.script ?? "";
  const explicitScript =
    platform === "default" ? defaultScript : (definition.platformScripts[platform] ?? "");
  const usesFallback = platform !== "default" && !explicitScript && Boolean(defaultScript);
  const resolvedScript = explicitScript || (usesFallback ? defaultScript : "");

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-base font-medium text-token-text-primary">{title}</h2>
          <p className="text-sm text-token-text-secondary">{description}</p>
        </div>
        {action}
      </div>

      {hasAnyScript ? (
        <PlatformSelector label={`${title} platform`} value={platform} onChange={setPlatform} />
      ) : null}

      {!hasAnyScript ? (
        <p className="text-sm text-token-text-secondary">No script configured</p>
      ) : resolvedScript ? (
        <div className="flex flex-col gap-2">
          {usesFallback ? (
            <p className="text-sm text-token-text-secondary">
              No platform override. Using the default script
            </p>
          ) : null}
          <LocalEnvironmentScriptPreview
            script={resolvedScript}
            language={platform === "win32" ? "text" : "bash"}
            ariaLabel={title}
          />
        </div>
      ) : (
        <p className="text-sm text-token-text-secondary">No script configured for this platform</p>
      )}
    </section>
  );
}

function ActionsSummary({ environment }: { environment: WorktreeEnvironmentDefinition }) {
  const [expandedActions, setExpandedActions] = useState<Set<number>>(new Set());

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium text-token-text-primary">Actions</h2>
        <p className="text-sm text-token-text-secondary">
          These actions can run any command and will be displayed in the header
        </p>
      </div>

      {environment.actions.length === 0 ? (
        <p className="text-sm text-token-text-secondary">No actions configured</p>
      ) : (
        <div className="divide-y-[0.5px] divide-token-border overflow-hidden rounded-lg border-[0.5px] border-token-border">
          {environment.actions.map((action, index) => {
            const expanded = expandedActions.has(index);
            const multiline = action.command.includes("\n");
            const commandId = `local-environment-command-${index}`;
            return (
              <div key={`${action.name}-${index}`} className="flex flex-col">
                <div className="flex min-h-12 items-center gap-3 px-3 py-2.5">
                  <LocalEnvironmentActionIcon
                    icon={action.icon}
                    className="shrink-0 text-token-text-secondary"
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium text-token-text-primary">
                      {action.name}
                    </span>
                    <code className="truncate text-xs text-token-text-secondary">
                      {action.command.split("\n", 1)[0]}
                    </code>
                  </div>
                  {multiline ? (
                    <NodexButton
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`${expanded ? "Hide" : "Show"} full command for ${action.name}`}
                      aria-expanded={expanded}
                      aria-controls={commandId}
                      onClick={() => {
                        setExpandedActions((current) => {
                          const next = new Set(current);
                          if (next.has(index)) next.delete(index);
                          else next.add(index);
                          return next;
                        });
                      }}
                    >
                      {expanded ? (
                        <ChevronDownIcon className="icon-xs rotate-180" />
                      ) : (
                        <ChevronDownIcon className="icon-xs" />
                      )}
                    </NodexButton>
                  ) : null}
                </div>
                {multiline && expanded ? (
                  <pre
                    id={commandId}
                    className={cn(
                      "m-0 overflow-auto border-t-[0.5px] border-token-border",
                      "bg-token-input-background px-3 py-2.5 font-mono text-xs whitespace-pre-wrap text-token-text-primary",
                    )}
                  >
                    {action.command}
                  </pre>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function LocalEnvironmentSummary({
  environment,
}: {
  environment: WorktreeEnvironmentDefinition;
}) {
  return (
    <div className="flex flex-col gap-10">
      <LifecycleSummary
        title="Setup script"
        description="This script runs on worktree creation"
        definition={environment.setup}
        action={<LocalEnvironmentVariablesPopover />}
      />
      <LifecycleSummary
        title="Cleanup script"
        description="Runs at the project root before worktree cleanup"
        definition={environment.cleanup}
      />
      <ActionsSummary environment={environment} />
    </div>
  );
}
