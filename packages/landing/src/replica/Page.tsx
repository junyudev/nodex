import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { useLumen } from "../demos/demo-locale";
import { useReplicaCopy } from "./copy";
import { PROVIDER_NAMES } from "../demos/lumen";
import { StatusIcon, type PageTurn, type Status } from "./Board";
import { cx } from "./Window";
import {
  ChatIcon,
  ChevronDownIcon,
  LinkedChatsIcon,
  MoreIcon,
  PageCodeIcon,
  PageFileImageIcon,
  PageFileJsonIcon,
  PageFullWidthIcon,
  PageIcon,
  PageStageHistoryIcon,
  PlusIcon,
  ProjectFolderOpenIcon,
  SpinnerIcon,
  StatusPropertyIcon,
} from "./icons";

/** A Page beside a Board or a chat: its toolbar, title, properties and body. */
export function PagePanel({
  title,
  properties,
  children,
}: {
  readonly title: string;
  readonly properties: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div className="relative flex h-full w-full min-w-0 flex-col overflow-hidden bg-app">
      <div className="flex h-11 shrink-0 items-center justify-end gap-0.5 px-3 text-app-faint">
        {[PageCodeIcon, PageFullWidthIcon, PageStageHistoryIcon, MoreIcon].map((Icon, index) => (
          <span key={index} className="flex size-6 items-center justify-center">
            <Icon className="size-[13px]" />
          </span>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden px-10 pt-5 pb-6 text-[13px] leading-[20px]">
        <div className="px-0.5 text-[23px] leading-[1.2] font-semibold tracking-[-0.01em]">
          {title}
        </div>
        <dl className="mt-2.5 border-b-[0.5px] border-app-line pb-3 text-[13px] leading-5">
          {properties}
        </dl>
        <div className="pt-3">{children}</div>
      </div>
    </div>
  );
}

/** PropertyRow: icon and label in a 128px column, the value from x136. */
function PageProperty({
  icon,
  label,
  trailing,
  children,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  /** Beside the label, such as the Files disclosure chevron. */
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid min-h-[30px] grid-cols-[128px_minmax(0,1fr)] items-start">
      <dt className="flex min-h-[30px] items-center gap-2 pr-2 text-[rgb(13_13_13/0.694)] dark:text-[rgb(252_252_252/0.71)]">
        <span className="flex size-4 shrink-0 items-center justify-center text-app-faint [&_svg]:size-4">
          {icon}
        </span>
        <span className="truncate">{label}</span>
        {trailing}
      </dt>
      <dd className="flex min-h-[30px] min-w-0 flex-col justify-center pl-2">{children}</dd>
    </div>
  );
}

/**
 * Status and Linked chats, as a work Page shows them: the stage, then whose move it is with its
 * action (status-turn.tsx), and the chat working on it.
 */
export function TaskProperties({
  status,
  turn,
  chat,
}: {
  readonly status: Status;
  readonly turn?: PageTurn;
  readonly chat: { readonly title: string; readonly working?: boolean };
}) {
  const copy = useReplicaCopy();
  return (
    <>
      <PageProperty icon={<StatusPropertyIcon />} label={copy.statusLabel}>
        <span className="flex min-w-0 flex-wrap items-center gap-x-3">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={status}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="inline-flex min-h-[30px] items-center gap-1.5 text-app-fg"
            >
              <StatusIcon status={status} className="size-4" /> {copy.status[status]}
            </motion.span>
          </AnimatePresence>
          {turn ? (
            <motion.span
              key={turn.kind}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="inline-flex min-h-[30px] min-w-0 flex-wrap items-center gap-x-2"
            >
              <span
                className={cx(
                  "whitespace-nowrap",
                  turn.kind === "review" ? "text-[#e25507] dark:text-[#ff8549]" : "text-app-muted",
                )}
              >
                {turn.kind === "review"
                  ? copy.readyForYourReview
                  : copy.isWorking(PROVIDER_NAMES[turn.provider])}
              </span>
              <span className="flex h-6 shrink-0 items-center rounded-[10px] px-2 text-[12px] leading-4 text-app-fg ring-[0.5px] ring-[rgb(13_13_13/0.118)] ring-inset dark:ring-[rgb(252_252_252/0.157)]">
                {turn.kind === "review" ? copy.accept : copy.openChat}
              </span>
            </motion.span>
          ) : null}
        </span>
      </PageProperty>
      <PageProperty icon={<LinkedChatsIcon />} label={copy.linkedChats}>
        <span className="flex min-h-7 items-center">
          <span className="inline-flex h-[22px] w-fit max-w-full min-w-0 items-center gap-1 rounded-[10px] px-1.5 text-app-fg ring-[0.5px] ring-[rgb(13_13_13/0.118)] ring-inset dark:ring-[rgb(252_252_252/0.157)]">
            <span className="flex size-4 shrink-0 items-center justify-center text-app-faint">
              {chat.working ? (
                <SpinnerIcon className="size-3" animationDurationMs={2_000} />
              ) : (
                <ChatIcon className="size-3" />
              )}
            </span>
            <span className="truncate">{chat.title}</span>
          </span>
        </span>
      </PageProperty>
    </>
  );
}

export type PageFileKind = "html" | "image" | "json";

export interface PageFile {
  readonly name: string;
  readonly kind: PageFileKind;
  readonly size: string;
}

export interface PageFolder {
  readonly name: string;
  readonly files: readonly PageFile[];
}

const FILE_GLYPH: Record<PageFileKind, (props: { className?: string }) => ReactNode> = {
  html: PageCodeIcon,
  image: PageFileImageIcon,
  json: PageFileJsonIcon,
};

// file-tree-icons.ts: a tree colors each file by kind; a tab shows the same glyph uncolored.
const FILE_TINT: Record<PageFileKind, string> = {
  html: "text-[#d47628] dark:text-[#ffa359]",
  image: "text-[#d32a61] dark:text-[#ff678d]",
  json: "text-[#d47628] dark:text-[#ffa359]",
};

/** Each file kind's glyph on the tab a file opens in. */
export const PAGE_FILE_ICON: Record<PageFileKind, ReactNode> = {
  html: <PageCodeIcon className="size-4" />,
  image: <PageFileImageIcon className="size-4" />,
  json: <PageFileJsonIcon className="size-4" />,
};

function FileGlyph({ kind }: { readonly kind: PageFileKind }) {
  const Glyph = FILE_GLYPH[kind];
  return <Glyph className={cx("size-4 shrink-0", FILE_TINT[kind])} />;
}

const fileCount = (folders: readonly PageFolder[]) =>
  folders.reduce((total, folder) => total + folder.files.length, 0);

const NONE_OPENED: readonly string[] = [];

/** A tree row: 28px, indented one 24px step per level from the Files label's icon. */
const treeRow = (depth: number) => ({ paddingLeft: 6 + 24 * (depth + 1) });

/** An open level's guide, centered under its glyph. */
function Guide({ depth }: { readonly depth: number }) {
  return (
    <span
      aria-hidden="true"
      className="absolute inset-y-0 w-px border-l-[0.5px] border-app-line"
      style={{ left: 6 + 24 * depth + 7.75 }}
    />
  );
}

/**
 * The Files property (page-files-row.tsx): the count with where the Files came from, and the
 * Page's file tree hanging beneath the row as its outline, across the Properties' width. Files
 * that arrived while the Page was open carry a new dot until they are opened.
 */
export function FilesProperty({
  folders,
  open = true,
  fresh = false,
  source,
  selected = null,
  opened = NONE_OPENED,
}: {
  readonly folders: readonly PageFolder[];
  readonly open?: boolean;
  /** The files arrived while the Page was open. */
  readonly fresh?: boolean;
  /** The chat that attached them, named once beside the count. */
  readonly source?: { readonly chat: string };
  /** The file being pressed or previewed. */
  readonly selected?: string | null;
  /** Files already opened, which no longer carry the new dot. */
  readonly opened?: readonly string[];
}) {
  const copy = useReplicaCopy();
  const count = fileCount(folders);
  const expanded = open && count > 0;
  return (
    <div>
      <PageProperty
        icon={<PageIcon />}
        label={copy.files}
        trailing={
          count > 0 ? (
            <ChevronDownIcon
              className={cx(
                "size-3.5 shrink-0 text-app-faint transition-transform duration-150",
                !expanded && "-rotate-90",
              )}
            />
          ) : null
        }
      >
        {count === 0 ? (
          <span className="text-app-faint">{copy.empty}</span>
        ) : (
          <span className="flex min-h-7 min-w-0 items-center gap-2">
            <span data-cursor-target="files" className="shrink-0 text-app-fg">
              {copy.fileCount(count)}
            </span>
            {source ? (
              <span className="flex min-w-0 items-center gap-1 text-app-faint">
                <span className="shrink-0">{copy.fileFrom}</span>
                <ChatIcon className="size-3 shrink-0" />
                <span className="truncate">{source.chat}</span>
                <span className="shrink-0">· {copy.now}</span>
              </span>
            ) : null}
            <PlusIcon className="size-3.5 shrink-0 text-app-faint opacity-60" />
          </span>
        )}
      </PageProperty>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="relative mb-1"
          >
            <Guide depth={0} />
            {folders.map((folder) => (
              <div key={folder.name} className="relative">
                <div
                  className="relative -mx-1.5 flex h-7 items-center gap-2 rounded-[10px] pr-1.5 text-app-muted"
                  style={treeRow(0)}
                >
                  <ProjectFolderOpenIcon className="size-4 shrink-0 text-app-faint" />
                  <span className="truncate">{folder.name}</span>
                </div>
                <div className="relative">
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-0 w-px border-l-[0.5px] border-app-line"
                    style={{ left: 24 + 7.75 }}
                  />
                  {folder.files.map((file, index) => (
                    <motion.div
                      key={file.name}
                      initial={fresh ? { opacity: 0 } : false}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.08 + index * 0.06 }}
                      data-cursor-target={`file:${file.name}`}
                      className={cx(
                        "relative -mx-1.5 flex h-7 items-center gap-2 rounded-[10px] pr-1.5",
                        selected === file.name && "bg-app-hover",
                      )}
                      style={treeRow(1)}
                    >
                      <FileGlyph kind={file.kind} />
                      <span className="min-w-0 truncate text-app-fg">{file.name}</span>
                      {fresh && !opened.includes(file.name) ? (
                        <span className="size-1.5 shrink-0 rounded-full bg-[#3a83f7]" />
                      ) : null}
                      <span className="flex-1" />
                      <span className="w-14 shrink-0 text-right text-[12px] text-app-faint tabular-nums">
                        {file.size}
                      </span>
                    </motion.div>
                  ))}
                </div>
              </div>
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

const COSTS = [
  { label: "hydrateWorkspace", ms: 1100, color: "#e5652e", fix: 900 },
  { label: "unsplitCharts", ms: 600, color: "#eba13f", fix: 400 },
  { label: "blockingFont", ms: 300, color: "#e8c547", fix: 200 },
  { label: "otherCosts", ms: 300, color: "var(--app-faint)", fix: 0 },
] as const;

const TOTAL = COSTS.reduce((sum, cost) => sum + cost.ms, 0);
const SAVED = COSTS.reduce((sum, cost) => sum + cost.fix, 0);

/** The profiling report the agent wrote as HTML, as the Page renders it. */
export function ColdStartReport() {
  const copy = useReplicaCopy();
  const seconds = (ms: number) => copy.seconds((ms / 1000).toFixed(1));
  const story = useLumen();
  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden rounded-[12px] bg-app-fg/[0.02] px-5 py-4 ring-[0.5px] ring-app-line ring-inset">
      <div className="flex flex-col gap-0.5">
        <span className="text-[10px] tracking-[0.08em] text-app-faint uppercase">
          {story.profileTitle}
        </span>
        <span className="text-[17px] font-semibold tracking-[-0.01em]">
          {story.titles.coldstart}
        </span>
      </div>
      <div className="flex items-end gap-3">
        <span className="flex flex-col">
          <span className="text-[10.5px] text-app-faint">{story.today}</span>
          <span className="text-[28px] leading-none font-semibold tracking-[-0.03em] text-[#e5652e] tabular-nums">
            {seconds(TOTAL)}
          </span>
        </span>
        <span className="pb-1 text-app-faint">→</span>
        <span className="flex flex-col">
          <span className="text-[10.5px] text-app-faint">{story.afterFixes}</span>
          <span className="text-[28px] leading-none font-semibold tracking-[-0.03em] text-[#30a46c] tabular-nums">
            {seconds(TOTAL - SAVED)}
          </span>
        </span>
      </div>
      <div className="flex h-3 overflow-hidden rounded-full bg-app-fg/5">
        {COSTS.map((cost, index) => (
          <motion.span
            key={cost.label}
            initial={{ width: 0 }}
            animate={{ width: `${(cost.ms / TOTAL) * 100}%` }}
            transition={{ delay: 0.35 + index * 0.12, duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }}
            className="h-full border-r border-app"
            style={{ background: cost.color }}
          />
        ))}
      </div>
      <div className="flex flex-col gap-2 text-[11.5px]">
        {COSTS.map((cost, index) => (
          <motion.div
            key={cost.label}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 + index * 0.1 }}
            className="grid grid-cols-[10px_minmax(0,1fr)_auto_auto] items-center gap-2"
          >
            <span className="size-2 rounded-[3px]" style={{ background: cost.color }} />
            <span className="truncate">{story[cost.label]}</span>
            <span className="text-app-muted tabular-nums">{seconds(cost.ms)}</span>
            <span className="w-14 text-right text-[#30a46c] tabular-nums">
              {cost.fix ? `−${seconds(cost.fix)}` : ""}
            </span>
          </motion.div>
        ))}
      </div>
      <motion.figure
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1 }}
        className="flex flex-col gap-1.5"
      >
        <figcaption className="text-[10.5px] text-app-faint">{story.mainThread}</figcaption>
        <Flamegraph />
      </motion.figure>
      <div className="flex flex-col gap-1.5 border-t-[0.5px] border-app-line pt-3 text-[11px] text-app-muted">
        <span className="font-medium text-app-fg">{story.suggestedFixes}</span>
        <span>{story.hydrateProject}</span>
        <span>{story.splitCharts}</span>
        <span>{story.preloadFont}</span>
      </div>
    </div>
  );
}

/** The profiler screenshot the agent attached, drawn to scale: the full width is 2.3 s. */
export function Flamegraph() {
  const copy = useReplicaCopy();
  const story = useLumen();
  const rows = [
    [[0, 100, "#e5652e", story.flamegraphTitle]],
    [
      [0, 48, "#e8803a", `hydrateWorkspace · ${copy.seconds("1.1")}`],
      [48, 52, "#e09a3e", "renderDashboard"],
    ],
    [
      [0, 39, "#eba13f", "loadWorkspaceTree"],
      [39, 9, "#d9b14a", "parse"],
      [48, 26, "#e8803a", `charts · ${copy.seconds("0.6")}`],
      [74, 13, "#d9b14a", "fonts"],
    ],
    [
      [0, 24, "#e5652e", "loadPages"],
      [24, 15, "#e8b04d", "buildTree"],
      [48, 18, "#e09a3e", "chunk.js"],
    ],
  ] as const;
  return (
    <svg viewBox="0 0 100 30" className="w-full rounded-[10px] bg-app-sidebar" aria-hidden="true">
      {rows.map((row, depth) =>
        row.map(([x, w, color, label]) => (
          <g key={`${depth}:${x}`}>
            <rect
              x={x + 0.3}
              y={1.2 + depth * 7}
              width={w - 0.6}
              height={6.2}
              rx={0.8}
              fill={color}
            />
            {label && w > 10 ? (
              <text x={x + 1.4} y={5.4 + depth * 7} fontSize={2.6} fill="rgb(0 0 0 / 0.72)">
                {label}
              </text>
            ) : null}
          </g>
        )),
      )}
    </svg>
  );
}
