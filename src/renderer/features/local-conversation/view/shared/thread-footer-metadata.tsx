import { UsedSkillsIcon } from "@/components/shared/icons/used-skills-icon";
import { useCodexMcpApps } from "../../use-codex-mcp-apps";
import { useId, useLayoutEffect, useState, type MouseEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AutomaticApprovalReviewIcon,
  ChevronDownIcon,
  GoalTargetIcon,
} from "@/components/shared/icons";
import { MemoryCitationIcon } from "@/components/shared/icons/memory-citation-icon";
import { NodexTooltip, dismissNodexTooltips } from "@/components/ui/tooltip";
import {
  NodexDialog,
  NodexDialogContent,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
  NodexDialogBody,
} from "@/components/ui/dialog";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { openModal, type ModalCloseProps } from "@/lib/modal-registry";
import { useFileReferenceRouter } from "@/lib/file-reference-router";
import {
  codexComposerSkillsListQueryOptions,
  codexComposerPluginsListQueryOptions,
} from "@/lib/query-options";
import type {
  TurnApprovalReview,
  TurnFooterMetadata,
  UsedTurnSkill,
} from "../../projection/turn-footer-metadata";
import { footerText, formatFooterNumber } from "./thread-footer-i18n";
import { formatWorkedForTimeLabel } from "../../thread-worked-for-time";

const buttonClassName =
  "no-drag flex cursor-default items-center justify-center rounded-full border border-transparent p-0.5 text-token-text-tertiary select-none focus:outline-none focus-visible:bg-token-list-hover-background focus-visible:text-token-foreground focus-visible:ring-2 focus-visible:ring-ring electron:rounded-md electron:p-1";
function MetadataTooltip({
  label,
  icon,
  children,
}: {
  label: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <NodexTooltip
      side="top"
      delay={700}
      sideOffset={2}
      hoverable
      tooltipClassName="px-3 py-2"
      style={{ maxWidth: "min(32rem, var(--available-width), calc(100vw - 16px))" }}
      tooltipContent={children}
    >
      <button type="button" aria-label={label} className={buttonClassName}>
        {icon}
      </button>
    </NodexTooltip>
  );
}

export function MemoriesCitedIndicator({ memories }: { memories: TurnFooterMetadata["memories"] }) {
  if (memories.length === 0) return null;
  return (
    <MetadataTooltip
      label={footerText(memories.length === 1 ? "1 memory citation" : "{count} memory citations", {
        count: formatFooterNumber(memories.length),
      })}
      icon={<MemoryCitationIcon className="icon-xs shrink-0" />}
    >
      <div className="flex min-w-0 flex-col gap-2 text-start">
        <div>{footerText("Memories cited")}</div>
        <ul className="flex min-w-0 list-disc flex-col gap-1 ps-4 opacity-65">
          {memories.map((memory, index) => (
            <li key={`${memory.path}:${memory.lineStart}:${index}`}>{memory.note}</li>
          ))}
        </ul>
      </div>
    </MetadataTooltip>
  );
}

function SkillDetails({
  skills,
  cwd,
  hostId,
}: {
  skills: UsedTurnSkill[];
  cwd?: string | null;
  hostId?: string;
}) {
  const router = useFileReferenceRouter();
  const { data: apps } = useCodexMcpApps();
  const catalog = useQuery(codexComposerSkillsListQueryOptions(cwd ? [cwd] : [], hostId));
  const plugins = useQuery(codexComposerPluginsListQueryOptions(cwd ? [cwd] : [], hostId));
  if (catalog.isLoading || plugins.isLoading) return <span aria-busy="true" />;
  const openSkill = (event: MouseEvent<HTMLAnchorElement>, path: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (hostId != null && hostId !== "local") return;
    dismissNodexTooltips();
    void router.open(
      { path },
      { cwd, external: event.metaKey || event.ctrlKey || event.button === 1 },
    );
  };
  return (
    <div className="flex min-w-0 flex-col gap-2 text-start">
      <div className="font-medium">{footerText("Skills")}</div>
      <ul className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
        {skills.map((skill) => {
          const known = catalog.data?.find((candidate) => candidate.path === skill.path);
          const pluginIdentity = skill.pluginMarketplaceName
            ? `${skill.pluginId}@${skill.pluginMarketplaceName}`
            : skill.pluginId;
          const plugin = plugins.data?.find(
            (candidate) =>
              candidate.id === pluginIdentity ||
              (!skill.pluginMarketplaceName && candidate.name === skill.pluginId),
          );
          const app = plugin
            ? apps?.find((candidate) => candidate.pluginDisplayNames.includes(plugin.displayName))
            : undefined;
          const source = app
            ? `${footerText("App")} · ${app.name}`
            : plugin
              ? `${footerText("Plugin")} · ${plugin.displayName}`
              : skill.pluginId
                ? `${footerText("Plugin")} · ${skill.pluginId}`
                : footerText(
                    known?.scope === "repo"
                      ? "Project"
                      : known?.scope === "user"
                        ? "User"
                        : known?.scope === "system"
                          ? "System"
                          : skill.source,
                  );
          return (
            <li key={skill.path} className="contents">
              {hostId != null && hostId !== "local" ? (
                <NodexTooltip
                  side="top"
                  delay={700}
                  tooltipContent={footerText("Opening files on this host is unavailable")}
                >
                  <span
                    role="link"
                    tabIndex={0}
                    aria-disabled="true"
                    className="min-w-0 cursor-not-allowed break-words whitespace-pre-wrap opacity-50"
                  >
                    {known?.displayName || skill.name}
                  </span>
                </NodexTooltip>
              ) : (
                <a
                  href={skill.path}
                  className="min-w-0 break-words whitespace-pre-wrap hover:underline"
                  onClick={(event) => openSkill(event, skill.path)}
                  onAuxClick={(event) => {
                    if (event.button === 1) openSkill(event, skill.path);
                  }}
                >
                  {known?.displayName || skill.name}
                </a>
              )}
              <span className="min-w-0 break-words whitespace-pre-wrap opacity-65">{source}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function UsedSkillsIndicator({
  skills,
  cwd,
  hostId,
}: {
  skills: UsedTurnSkill[];
  cwd?: string | null;
  hostId?: string;
}) {
  const [open, setOpen] = useState(false);
  if (skills.length === 0) return null;
  return (
    <NodexTooltip
      side="top"
      delay={700}
      sideOffset={2}
      hoverable
      open={open}
      onOpenChange={setOpen}
      tooltipClassName="px-3 py-2"
      style={{ maxWidth: "min(32rem, var(--available-width), calc(100vw - 16px))" }}
      tooltipContent={
        <span>{open ? <SkillDetails skills={skills} cwd={cwd} hostId={hostId} /> : null}</span>
      }
    >
      <button type="button" aria-label={footerText("Skills")} className={buttonClassName}>
        <UsedSkillsIcon className="icon-xs shrink-0" />
      </button>
    </NodexTooltip>
  );
}

export function GoalAchievedIndicator({ seconds }: { seconds: number }) {
  return (
    <span className="ms-1.5 flex h-full items-center gap-1.5 text-xs leading-5 text-token-text-tertiary">
      <span className="h-3 border-s border-token-border" />
      <GoalTargetIcon className="icon-xs shrink-0" />
      {footerText("Goal achieved in {totalTime}", {
        totalTime: formatWorkedForTimeLabel(seconds * 1000) ?? "0s",
      })}
    </span>
  );
}

function ApprovalReviewRow({ review }: { review: TurnApprovalReview }) {
  const [preview, setPreview] = useState<HTMLSpanElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    if (!preview) return;
    const measure = () => setOverflowing(preview.scrollWidth > preview.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(preview);
    return () => observer.disconnect();
  }, [preview]);
  const rejected = review.decision === "rejected";
  const longCommand = overflowing || review.command.trim().includes("\n");
  const expandable = rejected || longCommand;
  const Container = expandable ? "details" : "div";
  const Summary = expandable ? "summary" : "div";
  return (
    <li className={rejected ? "min-w-0 text-[var(--color-text-warning)]" : "min-w-0"}>
      <Container className="group/command min-w-0">
        <Summary
          className={`grid min-w-0 list-none grid-cols-[auto_minmax(0,1fr)] gap-3 marker:hidden ${expandable ? "cursor-pointer" : ""}`}
        >
          <span
            className={`flex items-center gap-1.5 ${rejected ? "" : "text-token-text-tertiary"}`}
          >
            <ChevronDownIcon
              className={`icon-xs -rotate-90 group-open/command:rotate-0 ${expandable ? "" : "invisible"}`}
            />
            {footerText(rejected ? "Rejected" : "Accepted")}
          </span>
          <span className="grid min-w-0">
            <span
              ref={setPreview}
              className={`col-start-1 row-start-1 min-w-0 truncate font-mono ${longCommand ? "group-open/command:invisible" : ""}`}
            >
              {review.command.trimStart().split("\n", 1)[0]}
            </span>
            {longCommand ? (
              <span className="col-start-1 row-start-1 hidden group-open/command:inline">
                {footerText("Command")}
              </span>
            ) : null}
          </span>
        </Summary>
        {expandable ? (
          <div className="mt-2 flex min-w-0 flex-col gap-2">
            {rejected ? (
              <p className="break-words whitespace-pre-wrap select-text">
                {review.rationale?.trim() || footerText("Auto-review did not include a rationale")}
              </p>
            ) : null}
            {longCommand ? (
              <pre className="min-w-0 font-mono break-words whitespace-pre-wrap select-text">
                {review.command}
              </pre>
            ) : null}
          </div>
        ) : null}
      </Container>
    </li>
  );
}

function AutoReviewStatsDialog({
  reviews,
  onClose,
}: ModalCloseProps & { reviews: TurnApprovalReview[] }) {
  const historyId = useId();
  const accepted = reviews.filter((review) => review.decision === "accepted").length;
  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <NodexDialogContent size="wide" aria-describedby={undefined}>
        <NodexDialogFrame>
          <NodexDialogHeader>
            <NodexDialogTitle>{footerText("Auto-review stats")}</NodexDialogTitle>
          </NodexDialogHeader>
          <NodexDialogBody>
            <div className="grid grid-cols-[auto_auto] justify-start gap-x-6 gap-y-1">
              <span>{footerText("Accepted")}</span>
              <span className="text-end">{formatFooterNumber(accepted)}</span>
              <span>{footerText("Rejected")}</span>
              <span className="text-end">{formatFooterNumber(reviews.length - accepted)}</span>
            </div>
            <div className="mt-4 flex min-h-0 min-w-0 flex-col gap-2 text-sm">
              <div id={historyId} className="text-token-text-tertiary">
                {footerText("Command history")}
              </div>
              <ul
                aria-labelledby={historyId}
                tabIndex={0}
                className="flex max-h-[60vh] min-h-0 min-w-0 flex-col gap-3 overflow-y-auto overscroll-contain"
              >
                {reviews.map((review) => (
                  <ApprovalReviewRow key={review.id} review={review} />
                ))}
              </ul>
            </div>
          </NodexDialogBody>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}

export function AutoReviewStatsIndicator({ reviews }: { reviews: TurnApprovalReview[] }) {
  const appHandle = useScopeHandle(appScope);
  if (reviews.length === 0) return null;
  const rejected = reviews.filter((review) => review.decision === "rejected").length;
  const label = rejected
    ? footerText("Auto-review stats ({count} rejected)", { count: formatFooterNumber(rejected) })
    : footerText("Auto-review stats");
  return (
    <NodexTooltip side="top" delay={700} sideOffset={2} tooltipContent={label}>
      <button
        type="button"
        aria-label={label}
        className={`${buttonClassName} cursor-pointer hover:bg-token-list-hover-background hover:text-token-foreground`}
        onClick={() => openModal(appHandle, AutoReviewStatsDialog, { reviews })}
      >
        <AutomaticApprovalReviewIcon
          className={`icon-sm shrink-0 ${rejected ? "text-[var(--color-text-warning)]" : ""}`}
        />
      </button>
    </NodexTooltip>
  );
}
