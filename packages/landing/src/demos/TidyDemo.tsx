import { AnimatePresence, LayoutGroup, motion, useTransform } from "motion/react";
import { useRef, type ReactNode } from "react";
import { AgentDock } from "../replica/AgentDock";
import { STATUSES, StatusIcon, type Status } from "../replica/Board";
import { AppSidebar, type SidebarChat } from "../replica/Sidebar";
import { Stage } from "../replica/Stage";
import { CAPTURE_DEMOS } from "./capture-demos";
import { AppWindow, PaneHeader, PaneTab, Tab, cx } from "../replica/Window";
import {
  BoardIcon,
  ChevronDownIcon,
  CheckIcon,
  DatabaseFilterIcon,
  DatabaseSettingsIcon,
  DatabaseSortIcon,
  EditFilesIcon,
  InboxIcon,
  ListIcon,
  PriorityValueIcon,
  ReadFilesIcon,
  SearchIcon,
  SpinnerIcon,
  TerminalActivityIcon,
} from "../replica/icons";
import { AGENTS } from "./lumen";
import { useTimeline, useTyped, type Cue, type Timeline } from "./timeline";

type Priority = "high" | "medium" | "low";

interface Task {
  readonly key: string;
  readonly title: string;
  readonly priority: Priority;
  /** Where the agent files it; tasks without one stay in Triage for the reader. */
  readonly to?: Status;
  /** Auth work is raised to P1 on the way. */
  readonly raise?: boolean;
}

/** A backlog that piled up in Triage, newest first. */
const TASKS: readonly Task[] = [
  { key: "LUM-40", title: "Upgrade React to 20", priority: "low" },
  { key: "LUM-38", title: "Dashboard cold start", priority: "medium", to: "Review" },
  { key: "LUM-36", title: "Settings dark mode contrast", priority: "low", to: "Ship" },
  { key: "LUM-35", title: "Idempotent Stripe webhooks", priority: "high", to: "Review" },
  { key: "LUM-33", title: "Onboarding checklist copy", priority: "low" },
  { key: "LUM-31", title: "Fix the flaky upload test", priority: "medium", to: "Ship" },
  { key: "LUM-30", title: "Audit log export", priority: "medium", to: "Plan" },
  {
    key: "LUM-28",
    title: "Remember auth on trusted devices",
    priority: "low",
    to: "Build",
    raise: true,
  },
  { key: "LUM-26", title: "Rate limiter for the public API", priority: "medium", to: "Ship" },
  { key: "LUM-24", title: "Weekly workspace digest", priority: "low", to: "Plan" },
  { key: "LUM-23", title: "SSO auth loop in Safari", priority: "medium", to: "Build", raise: true },
  { key: "LUM-21", title: "Billing page copy", priority: "low", to: "Plan" },
  {
    key: "LUM-19",
    title: "Auth tokens expire mid-session",
    priority: "medium",
    to: "Build",
    raise: true,
  },
  { key: "LUM-17", title: "Passkey sign-in", priority: "medium", to: "Build", raise: true },
  { key: "LUM-12", title: "Dark mode for the marketing site", priority: "low", to: "Ship" },
];

const MOVED = TASKS.filter((task) => task.to);
const REQUEST =
  "Tidy up the backlog: shipped work to Ship, auth to Build at P1, the rest where it belongs.";

const TYPE_AT = 500;
const TYPE_MS = 17;
const SENT = TYPE_AT + REQUEST.length * TYPE_MS + 250;
const READ = SENT + 300;
const QUERY = READ + 1300;
const APPLY = QUERY + 900;
const MOVE_MS = 70;

/** The window leaves a margin on wide screens for the note on what the agent runs. */
const WINDOW_WIDTH = 870;
const NOTE_WIDTH = 276;
const NOTE_LEFT = 1180 - NOTE_WIDTH;
const NOTE_ANCHOR_Y = 470;
/** The dock input's right end: centered in the pane right of the 262px rail and sidebar. */
const DOCK_RIGHT = WINDOW_WIDTH - 12 - (WINDOW_WIDTH - 262 - 24 - 520) / 2;
const DOCK_Y = 668;

/**
 * What the agent runs behind the dock, explained in a margin note beside the window rather than
 * drawn as part of the app: one read-only SQL query, then one atomic batch of typed edits.
 */
const QUERY_CODE = `nodex sql query
  SELECT page_id, title, "Status"
  FROM tasks
  WHERE "Status" = :triage`;
const APPLY_CODE = `nodex page properties apply
  --input tidy.json`;
const CODE_MS = 14;
const APPLIED = APPLY + MOVED.length * MOVE_MS + 350;

const CUES: readonly Cue[] = [
  { id: "typing", at: TYPE_AT },
  { id: "sent", at: SENT },
  { id: "read", at: READ },
  { id: "query", at: QUERY },
  { id: "apply", at: APPLY },
  ...MOVED.map((task, index) => ({ id: `moved:${task.key}`, at: APPLY + index * MOVE_MS })),
  { id: "applied", at: APPLIED },
  { id: "summary", at: APPLIED + 250 },
  { id: "dock", at: APPLIED + 3800 },
];

const CHATS: readonly SidebarChat[] = [
  { title: "Passkey sign-in", project: "lumen-web", provider: "claude", working: true },
  { title: "Dashboard cold start", project: "lumen-web", provider: "opencode", working: false },
];

/**
 * One request in plain words, and the agent files a whole backlog: it reads every Page, queries
 * the Database, and applies all the edits as one batch while the List regroups under it.
 */
export default function TidyDemo() {
  const root = useRef<HTMLDivElement | null>(null);
  const timeline = useTimeline({ cues: CUES, durationMs: APPLIED + 6800 }, root);
  const { reached, elapsed } = timeline;
  const typed = useTyped(elapsed, REQUEST, TYPE_AT, TYPE_MS);
  const placeholderOpacity = useTransform(elapsed, (t): number => (t >= TYPE_AT ? 0 : 1));
  const statusOf = (task: Task): Status =>
    task.to && reached(`moved:${task.key}`) ? task.to : "Triage";

  return (
    <div ref={root} className="w-full">
      <Stage {...CAPTURE_DEMOS.tidy} compactWidth={640} compactHeight={760}>
        {({ compact }) => (
          <>
            <div
              className="absolute inset-y-0 left-0"
              style={{ width: compact ? "100%" : WINDOW_WIDTH }}
            >
              <AppWindow
                key={timeline.loop}
                sidebar={
                  compact ? undefined : (
                    <AppSidebar chats={CHATS} selection={{ kind: "project", name: "lumen-web" }} />
                  )
                }
                tabs={
                  <>
                    <Tab icon={<InboxIcon className="size-4" />} label="Inbox" />
                    <Tab icon={<BoardIcon className="size-4" />} label="lumen-web" active />
                  </>
                }
              >
                <div className="absolute inset-0 flex flex-col">
                  <PaneHeader
                    left={
                      <>
                        <PaneTab icon={<BoardIcon className="size-4" />} label="Board" />
                        <PaneTab icon={<ListIcon className="size-4" />} label="List" active />
                      </>
                    }
                    right={
                      <div className="flex items-center gap-0.5 text-app-faint">
                        {[
                          DatabaseSettingsIcon,
                          DatabaseFilterIcon,
                          DatabaseSortIcon,
                          SearchIcon,
                        ].map((Icon, index) => (
                          <span key={index} className="flex size-6 items-center justify-center">
                            <Icon className="size-[13px]" />
                          </span>
                        ))}
                      </div>
                    }
                  />
                  <LayoutGroup>
                    <div className="min-h-0 flex-1 overflow-hidden px-4 pt-1 text-[12.5px]">
                      {STATUSES.map((status) => {
                        const rows = TASKS.filter((task) => statusOf(task) === status);
                        return (
                          <AnimatePresence key={status} initial={false}>
                            {rows.length > 0 ? (
                              <motion.section
                                layout
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={{ type: "spring", stiffness: 300, damping: 32 }}
                                className="pb-1.5"
                              >
                                <motion.div
                                  layout="position"
                                  className="flex h-7 items-center gap-1.5 px-1.5 text-app-muted"
                                >
                                  <ChevronDownIcon className="size-3 text-app-faint" />
                                  <StatusIcon status={status} className="size-[13px]" />
                                  <span className="text-app-fg">{status}</span>
                                  <span className="tabular-nums">{rows.length}</span>
                                </motion.div>
                                {rows.map((task) => (
                                  <TaskRow
                                    key={task.key}
                                    task={task}
                                    status={status}
                                    index={TASKS.indexOf(task)}
                                    timeline={timeline}
                                  />
                                ))}
                              </motion.section>
                            ) : null}
                          </AnimatePresence>
                        );
                      })}
                    </div>
                  </LayoutGroup>
                  <AgentDock
                    agent={AGENTS.opus}
                    active={reached("typing") && !reached("sent")}
                    input={
                      reached("sent") ? undefined : (
                        <motion.span>
                          <motion.span>{typed}</motion.span>
                          <motion.span
                            style={{ opacity: placeholderOpacity }}
                            className="text-app-fg/30"
                          >
                            Do anything
                          </motion.span>
                        </motion.span>
                      )
                    }
                    card={
                      reached("sent") && !reached("dock") ? <Activity timeline={timeline} /> : null
                    }
                  />
                </div>
              </AppWindow>
            </div>
            {compact ? null : <UnderTheHood timeline={timeline} />}
          </>
        )}
      </Stage>
    </div>
  );
}

function TaskRow({
  task,
  status,
  index,
  timeline,
}: {
  readonly task: Task;
  readonly status: Status;
  readonly index: number;
  readonly timeline: Timeline;
}) {
  const { reached } = timeline;
  const moved = Boolean(task.to) && reached(`moved:${task.key}`);
  const priority: Priority = moved && task.raise ? "high" : task.priority;
  return (
    <motion.div
      layout="position"
      layoutId={task.key}
      transition={{ type: "spring", stiffness: 260, damping: 30 }}
      className="relative grid h-[26px] grid-cols-[16px_52px_16px_minmax(0,1fr)] items-center gap-2 rounded-[6px] px-1.5"
    >
      {/* The agent reading every Page, one after another. */}
      {reached("read") && !reached("query") ? (
        <motion.span
          aria-hidden="true"
          className="absolute inset-0 rounded-[6px] bg-app-fg/[0.06]"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 0] }}
          transition={{ delay: index * 0.07, duration: 0.5 }}
        />
      ) : null}
      {moved ? (
        <motion.span
          aria-hidden="true"
          className="absolute inset-0 rounded-[6px] bg-[#3a83f7]/14"
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ delay: 0.5, duration: 1.6 }}
        />
      ) : null}
      <span className="relative flex justify-center text-app-faint">
        <PriorityValueIcon priority={priority} className="size-[13px]" />
      </span>
      <span className="relative text-app-faint tabular-nums">{task.key}</span>
      <span className="relative flex justify-center">
        <StatusIcon status={status} className="size-[13px]" />
      </span>
      <span className="relative truncate">{task.title}</span>
    </motion.div>
  );
}

/** What the agent does with the request, step by step, and what it changed. */
function Activity({ timeline }: { readonly timeline: Timeline }) {
  const { reached } = timeline;
  const counts = STATUSES.filter((status) => status !== "Triage").map((status) => ({
    status,
    count: MOVED.filter((task) => task.to === status).length,
  }));
  return (
    <div className="flex flex-col gap-2">
      <p className="line-clamp-2 leading-[18px] text-app-fg">{REQUEST}</p>
      <div className="flex flex-col gap-1 text-app-muted">
        <Step done={reached("query")} icon={<ReadFilesIcon className="size-3.5" />}>
          {reached("query") ? `Read ${TASKS.length} Pages in lumen-web` : "Reading the backlog"}
        </Step>
        {reached("query") ? (
          <Step done={reached("apply")} icon={<TerminalActivityIcon className="size-3.5" />}>
            {reached("apply") ? `Queried lumen-web · ${TASKS.length} rows` : "Querying lumen-web"}
          </Step>
        ) : null}
        {reached("apply") ? (
          <Step done={reached("applied")} icon={<EditFilesIcon className="size-3.5" />}>
            {reached("applied")
              ? `Applied ${MOVED.length} edits in one batch`
              : `Applying ${MOVED.length} edits`}
          </Step>
        ) : null}
      </div>
      {reached("summary") ? (
        <motion.p
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-start gap-1.5 leading-[18px]"
        >
          <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-[#30a46c]" />
          <span>
            Moved {MOVED.length} Pages:{" "}
            {counts.map(({ status, count }, index) => (
              <span key={status}>
                {index > 0 ? ", " : ""}
                {count} to {status}
              </span>
            ))}
            . Auth work is now P1. Two still need you in Triage.
          </span>
        </motion.p>
      ) : null}
    </div>
  );
}

function Step({
  done,
  icon,
  children,
}: {
  readonly done: boolean;
  readonly icon: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 3 }}
      animate={{ opacity: 1, y: 0 }}
      className={cx("flex h-5 items-center gap-1.5", done && "text-app-fg/80")}
    >
      {done ? icon : <SpinnerIcon className="size-3.5" />}
      {children}
    </motion.div>
  );
}

/**
 * A margin note beside the window, in the page's own style, explaining what the agent runs
 * while the dock reports its progress in plain words. A dashed leader ties it to the dock.
 */
function UnderTheHood({ timeline }: { readonly timeline: Timeline }) {
  const { reached } = timeline;
  return (
    <AnimatePresence>
      {reached("read") ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5 }}
          className="pointer-events-none absolute inset-0"
        >
          <svg className="absolute inset-0 size-full overflow-visible" aria-hidden="true">
            <path
              d={`M ${NOTE_LEFT} ${NOTE_ANCHOR_Y} C ${NOTE_LEFT - 44} ${NOTE_ANCHOR_Y}, ${DOCK_RIGHT + 30} ${DOCK_Y}, ${DOCK_RIGHT + 6} ${DOCK_Y}`}
              fill="none"
              stroke="var(--site-ink-3)"
              strokeWidth="1.2"
              strokeDasharray="3 4"
            />
            <circle cx={DOCK_RIGHT + 4} cy={DOCK_Y} r="3" fill="var(--site-ink-3)" />
          </svg>
          <div
            style={{ width: NOTE_WIDTH }}
            className="absolute top-[150px] right-0 flex flex-col gap-4 rounded-2xl border border-dashed border-ink-3/40 bg-raised/70 p-4 font-sans text-ink backdrop-blur"
          >
            <div className="flex flex-col gap-1">
              <span className="font-mono text-[10.5px] tracking-[0.14em] text-ink-3 uppercase">
                Under the hood
              </span>
              <span className="text-[13px] leading-[19px] text-ink-2">
                The agent works through the <span className="font-mono text-ink">nodex</span> CLI.
                Two commands do the whole job.
              </span>
            </div>
            <NoteStep
              index={1}
              title="One SQL query reads the backlog"
              code={QUERY_CODE}
              start={READ + 150}
              result={`${TASKS.length} rows`}
              active={!reached("query")}
              done={reached("query")}
              timeline={timeline}
            />
            <NoteStep
              index={2}
              title="One transaction applies every edit"
              code={APPLY_CODE}
              start={QUERY + 150}
              result={`${MOVED.length} edits · 1 transaction`}
              active={reached("query") && !reached("applied")}
              done={reached("applied")}
              timeline={timeline}
            />
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function NoteStep({
  index,
  title,
  code,
  start,
  result,
  active,
  done,
  timeline,
}: {
  readonly index: number;
  readonly title: string;
  readonly code: string;
  readonly start: number;
  readonly result: string;
  readonly active: boolean;
  readonly done: boolean;
  readonly timeline: Timeline;
}) {
  const typed = useTyped(timeline.elapsed, code, start, CODE_MS);
  return (
    <div
      className={cx(
        "flex flex-col gap-1.5 transition-opacity duration-500",
        active || done ? "opacity-100" : "opacity-40",
      )}
    >
      <span className="flex items-baseline gap-2 text-[13px] font-medium">
        <span className="font-mono text-[11px] text-ink-3">0{index}</span>
        {title}
      </span>
      <pre className="min-h-[34px] rounded-lg bg-ink/[0.045] px-2.5 py-2 font-mono text-[11px] leading-[16px] whitespace-pre text-ink-2">
        <motion.span>{typed}</motion.span>
      </pre>
      <span
        className={cx(
          "font-mono text-[11px] transition-opacity duration-300",
          done ? "text-[#30a46c] opacity-100" : "opacity-0",
        )}
      >
        → {result}
      </span>
    </div>
  );
}
