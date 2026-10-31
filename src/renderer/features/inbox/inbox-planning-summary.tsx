import { useEffect, useRef, useState, type ReactNode } from "react";
import { MAX_INBOX_INSTRUCTIONS_CHARS } from "../../../shared/inbox";
import type { InboxSuggestionPolicy } from "../../../shared/inbox-suggestion-policy";
import { AgentProviderIcon, PauseIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { NodexHoverCard } from "@/components/ui/hover-card";
import { UsageMeterCard, UsageRingGlyph } from "@/components/workbench/workbench-rail-usage-meter";
import { useClockAt } from "@/lib/use-clock-at";
import { describeUsageMeterLabel, type UsageSeverity } from "@/lib/usage-meter";
import { cn } from "@/lib/utils";
import { inboxAgentLine, type InboxAgentPresentation } from "./inbox-agent-model";
import {
  InboxAgentInlineTrigger,
  InboxChatAgentPicker,
  InboxSuggestionAgentPicker,
  type InboxAgents,
} from "./inbox-agent-picker";
import {
  describeInboxPlanning,
  inboxPlanningNextChange,
  type InboxPlanning,
  type InboxPlanningBudget,
  type InboxPlanningModel,
} from "./inbox-planning";
import { INBOX_ROUTING_PREFERENCES_PLACEHOLDER } from "./inbox-presentation";

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      {/* A label sits on the first line of its value, whose controls are a row tall. */}
      <dt className="py-[3.5px] text-token-description-foreground">{label}</dt>
      <dd className="min-w-0 text-token-foreground">{children}</dd>
    </>
  );
}

/** A choice shown as its value; the composer's model menu opens from it. */
function inlineTrigger(presentation: InboxAgentPresentation, label: string) {
  return (
    <InboxAgentInlineTrigger
      presentation={presentation}
      aria-label={`${label} ${inboxAgentLine(presentation)}`}
      className="-ml-1.5 text-token-foreground"
    />
  );
}

/** How often an empty Inbox reads Main's catalog again; reading it never forces discovery. */
const CATALOG_REREAD_MS = 60_000;

const BUDGET_TONE: Partial<Record<UsageSeverity, string>> = {
  low: "text-(--yellow-text)",
  critical: "text-(--red-text)",
};

function budgetText(budget: InboxPlanningBudget): string {
  switch (budget.kind) {
    case "free":
      return "Free";
    case "left":
      return [`${budget.percent}% left`, budget.window, budget.readAgo].filter(Boolean).join(" · ");
    case "spent":
      return ["Used up", budget.window].filter(Boolean).join(" · ");
    case "reset":
      return "Reset since read";
    case "unknown":
      return "Not reported";
  }
}

/** The Agent's mark in the rail's usage ring, with the rail's card on hover. */
function BudgetRing({
  model,
  nowMs,
}: {
  readonly model: InboxPlanningModel;
  readonly nowMs: number;
}) {
  const { budget, usage } = model;
  const mark = <AgentProviderIcon kind={model.kind} className="fill-current" />;
  const track = budget.kind === "spent" ? "spent" : budget.kind === "left" ? "solid" : "dotted";
  // Free models spend nothing, and an Agent that reports no windows has no card to show.
  if (!usage || usage.windows.length === 0)
    return usage ? (
      <span className="inline-flex shrink-0 text-token-foreground">
        <UsageRingGlyph provider={model.kind} mark={mark} track={track} />
      </span>
    ) : (
      <span className="inline-flex size-6 shrink-0 items-center justify-center [&>svg]:size-3">
        {mark}
      </span>
    );
  return (
    <NodexHoverCard
      ariaLabel={`${usage.reading.title} usage details`}
      placement="left-start"
      hoverCardContent={<UsageMeterCard view={usage} now={nowMs} />}
    >
      <button
        type="button"
        aria-label={describeUsageMeterLabel(usage, nowMs)}
        className="cursor-interaction inline-flex shrink-0 rounded-full text-token-foreground outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border"
      >
        <UsageRingGlyph
          provider={model.kind}
          mark={mark}
          track={track}
          arc={
            budget.kind === "left"
              ? {
                  percent: budget.percent,
                  severity: budget.severity,
                  faded: budget.readAgo !== null,
                }
              : null
          }
        />
      </button>
    </NodexHoverCard>
  );
}

function ModelRow({
  model,
  nowMs,
}: {
  readonly model: InboxPlanningModel;
  readonly nowMs: number;
}) {
  const { budget } = model;
  return (
    <li data-inbox-planning-model={model.key} className="flex min-w-0 items-start gap-2.5">
      <BudgetRing model={model} nowMs={nowMs} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-6 items-center gap-2">
          <span className="min-w-0 truncate font-medium">{model.title}</span>
          <span
            className={cn(
              "ml-auto shrink-0 text-token-description-foreground tabular-nums",
              budget.kind === "left" && BUDGET_TONE[budget.severity],
              budget.kind === "left" && budget.readAgo && "opacity-60",
              budget.kind === "spent" && "text-(--red-text)",
            )}
          >
            {budgetText(budget)}
          </span>
        </div>
        {model.summary ? (
          <p className="-mt-0.5 text-token-text-secondary">{model.summary}</p>
        ) : null}
      </div>
    </li>
  );
}

/** What suggestions choose a new chat's model among: the guide's families and their budgets. */
function ChosenModels({
  planning,
  agents,
  nowMs,
}: {
  readonly planning: Extract<
    Extract<InboxPlanning, { kind: "suggests" }>["models"],
    { kind: "chosen" }
  >;
  readonly agents: InboxAgents;
  readonly nowMs: number;
}) {
  if (planning.models.length > 0)
    return (
      <ul className="flex flex-col gap-2">
        {planning.models.map((model) => (
          <ModelRow key={model.key} model={model} nowMs={nowMs} />
        ))}
      </ul>
    );
  if (planning.catalog === "error")
    return (
      <span className="flex items-center gap-2 py-[3.5px] text-token-description-foreground">
        Couldn’t load Agents
        <NodexButton size="xs" variant="ghost" className="-my-1" onClick={agents.reload}>
          Retry
        </NodexButton>
      </span>
    );
  return (
    <span className="block py-[3.5px] text-token-description-foreground">
      {planning.catalog === "loading" ? "Loading…" : "No Agent can take a new chat right now."}
    </span>
  );
}

/**
 * The routing preferences, quoted, and written in place. They are the user's standing
 * instructions to suggestions; Settings keeps the same text.
 */
function RoutingPreferences({
  preferences,
  agents,
}: {
  readonly preferences: string;
  readonly agents: InboxAgents;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (draft === null)
    return (
      <button
        type="button"
        onClick={() => setDraft(preferences)}
        aria-label={preferences ? "Edit routing preferences" : "Add routing preferences"}
        className="cursor-interaction -mx-1.5 block w-[calc(100%+0.75rem)] rounded-md px-1.5 py-[3.5px] text-left hover:bg-token-list-hover-background"
      >
        {preferences ? (
          <span className="line-clamp-4 whitespace-pre-line">“{preferences}”</span>
        ) : (
          <span className="text-token-description-foreground">Add your own…</span>
        )}
      </button>
    );
  const next = draft.trim();
  const save = () => {
    if (saving) return;
    if (next === preferences) return setDraft(null);
    setSaving(true);
    void agents.save({ instructions: next }).then((saved) => {
      setSaving(false);
      // Writing that went on while it saved stays open.
      if (saved) setDraft((current) => (current?.trim() === next ? null : current));
    });
  };
  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        // Writing starts at once: the reader asked to write.
        autoFocus
        aria-label="Routing preferences"
        maxLength={MAX_INBOX_INSTRUCTIONS_CHARS}
        value={draft}
        placeholder={INBOX_ROUTING_PREFERENCES_PLACEHOLDER}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onFocus={(event) => {
          const end = event.currentTarget.value.length;
          event.currentTarget.setSelectionRange(end, end);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDraft(null);
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            save();
          }
        }}
        className="-mx-1.5 max-h-48 min-h-[4.5rem] w-[calc(100%+0.75rem)] resize-none rounded-md bg-token-input-background px-1.5 py-[3.5px] text-xs leading-[17px] text-token-input-foreground ring-[0.5px] ring-token-input-border outline-none [field-sizing:content] placeholder:text-token-input-placeholder-foreground focus:ring-token-focus-border"
      />
      <div className="flex items-center justify-end gap-1">
        <NodexButton size="xs" variant="ghost" onClick={() => setDraft(null)}>
          Cancel
        </NodexButton>
        <NodexButton size="xs" variant="secondary" disabled={saving} onClick={save}>
          Save
        </NodexButton>
      </div>
    </div>
  );
}

function footer(planning: InboxPlanning, projectName: string | null): string {
  if (planning.kind === "off") return "You decide where each message goes.";
  const { models, preferences } = planning;
  const weighs =
    models.kind === "fixed"
      ? "Suggestions choose where each message goes, not which model runs it."
      : `Each suggestion ${preferences ? "follows your routing preferences first, then weighs" : "weighs"} ${
          models.models.some((model) => model.summary)
            ? "what a model does well and how much of its weekly budget is left."
            : "how much of each Agent’s weekly budget is left."
        }`;
  return projectName ? `${weighs} Chats stay in ${projectName}.` : weighs;
}

/**
 * How the Inbox will plan the next messages, from the settings, model guide and budgets it plans
 * with: who suggests, what chats can run on, and the user's own routing preferences. Each value
 * that is a setting changes in place.
 */
export function InboxPlanningSummary({
  agents,
  policy,
  nowMs,
  projectName,
  className,
}: {
  readonly agents: InboxAgents;
  readonly policy: InboxSuggestionPolicy;
  readonly nowMs: number;
  /** Set for a Project's Inbox, whose chats stay in the Project. */
  readonly projectName: string | null;
  readonly className?: string;
}) {
  // Budgets move while the Inbox sits empty: read Main's catalog again now and then, as
  // suggestions would, and move the clock when a window resets or a reading ages.
  const reload = useRef(agents.reload);
  useEffect(() => {
    reload.current = agents.reload;
  });
  useEffect(() => {
    reload.current();
    const interval = window.setInterval(() => reload.current(), CATALOG_REREAD_MS);
    return () => window.clearInterval(interval);
  }, []);
  const [clock, setClock] = useState(nowMs);
  const now = Math.max(nowMs, clock);
  const planning = describeInboxPlanning(agents, agents.settings, policy, now);
  useClockAt(inboxPlanningNextChange(planning), setClock);
  // Until the user's settings arrive, nothing here could be theirs.
  if (!agents.settingsReady) return null;
  const ready = agents.state === "ready";
  // What every new chat runs on, unless suggestions choose.
  const fixedChat =
    planning.kind === "off"
      ? planning.chat
      : planning.models.kind === "fixed"
        ? planning.models.chat
        : null;
  return (
    <section
      aria-label="How the Inbox plans"
      data-testid="inbox-planning"
      className={cn(
        "flex w-full max-w-124 flex-col gap-2.5 rounded-2xl bg-token-foreground/[0.025] px-4 pt-3.5 pb-3 text-left text-xs leading-[17px] ring-[0.5px] ring-token-border [corner-shape:superellipse(1.5)]",
        className,
      )}
    >
      <dl className="grid grid-cols-[7.75rem_minmax(0,1fr)] gap-x-3 gap-y-3">
        {planning.kind === "off" ? (
          <Row label="Suggestions">
            <span className="block py-[3.5px]">Off</span>
          </Row>
        ) : (
          <Row label="Suggested by">
            <div className="flex min-w-0 items-center gap-2">
              <InboxSuggestionAgentPicker
                agents={agents}
                trigger={inlineTrigger(planning.suggestedBy, "Suggests with")}
                disabled={!ready}
              />
              {planning.when === "automatic" ? null : (
                <span className="ml-auto flex shrink-0 items-center gap-1 text-token-description-foreground">
                  {planning.when === "paused" ? (
                    <>
                      <PauseIcon className="icon-2xs" />
                      Paused
                    </>
                  ) : (
                    "When you ask"
                  )}
                </span>
              )}
            </div>
          </Row>
        )}
        {fixedChat ? (
          <Row label="New chats">
            <InboxChatAgentPicker
              agents={agents}
              trigger={inlineTrigger(fixedChat, "New chats run on")}
              disabled={!ready}
            />
          </Row>
        ) : planning.kind === "suggests" && planning.models.kind === "chosen" ? (
          <Row
            label={
              planning.models.models.some((model) => model.summary) ? "Model guide" : "Budgets"
            }
          >
            <ChosenModels planning={planning.models} agents={agents} nowMs={now} />
          </Row>
        ) : null}
        {planning.kind === "off" ? null : (
          <Row label="Routing preferences">
            <RoutingPreferences preferences={planning.preferences} agents={agents} />
          </Row>
        )}
      </dl>
      <p className="border-t-[0.5px] border-token-border pt-2.5 text-token-description-foreground">
        {footer(planning, projectName)}
      </p>
    </section>
  );
}
