import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import type { ProviderKind } from "../demos/lumen";
import { StatusIcon, type Status } from "./Board";
import { ProviderMark, cx } from "./Window";
import {
  ChevronDownIcon,
  FolderIcon,
  LinkedChatsIcon,
  MoreIcon,
  PageCodeIcon,
  PageFileImageIcon,
  PageFileJsonIcon,
  PageFullWidthIcon,
  PageIcon,
  PageStageHistoryIcon,
  PriorityPropertyIcon,
  PriorityValueIcon,
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
        <dl className="mt-3 border-b-[0.5px] border-app-line pb-3 text-[12px] leading-4">
          {properties}
        </dl>
        <div className="pt-3">{children}</div>
      </div>
    </div>
  );
}

function PageProperty({
  icon,
  label,
  children,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid min-h-[26px] grid-cols-[110px_minmax(0,1fr)] items-start">
      <dt className="flex min-h-[26px] items-center gap-[5px] pl-1 text-app-muted">
        <span className="flex w-4 shrink-0 items-center justify-center text-app-faint [&_svg]:size-[13px]">
          {icon}
        </span>
        {label}
      </dt>
      <dd className="flex min-h-[26px] min-w-0 flex-col justify-center py-0.5 pl-1.5">
        {children}
      </dd>
    </div>
  );
}

/** Status, Priority and Linked chats, the properties every task Page in these demos shows. */
export function TaskProperties({
  status,
  chat,
}: {
  readonly status: Status;
  readonly chat: { readonly title: string; readonly provider: ProviderKind };
}) {
  return (
    <>
      <PageProperty icon={<StatusPropertyIcon />} label="Status">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={status}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="inline-flex items-center gap-1.5 px-1 text-app-fg"
          >
            <StatusIcon status={status} className="size-[13px]" /> {status}
          </motion.span>
        </AnimatePresence>
      </PageProperty>
      <PageProperty icon={<PriorityPropertyIcon />} label="Priority">
        <span className="inline-flex items-center gap-1.5 px-1 text-app-muted">
          <PriorityValueIcon priority="high" className="size-[13px] text-app-faint" />
          P1 - High
        </span>
      </PageProperty>
      <PageProperty icon={<LinkedChatsIcon />} label="Linked chats">
        <span className="inline-flex w-fit max-w-full min-w-0 items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-app-muted ring-[0.5px] ring-app-line ring-inset">
          <ProviderMark kind={chat.provider} className="size-2.5" />
          <span className="truncate">{chat.title}</span>
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

/** Each file kind's glyph, in the Page's file tree and on the tab a file opens in. */
export const PAGE_FILE_ICON: Record<PageFileKind, ReactNode> = {
  html: <PageCodeIcon className="size-3.5 text-[#3a83f7]" />,
  image: <PageFileImageIcon className="size-3.5 text-[#d32a61] dark:text-[#ff678d]" />,
  json: <PageFileJsonIcon className="size-3.5 text-[#d47628] dark:text-[#ffa359]" />,
};

const fileCount = (folders: readonly PageFolder[]) =>
  folders.reduce((total, folder) => total + folder.files.length, 0);

/**
 * The Files property: a count that opens into the Page's own file tree, right under the
 * properties, with where the files came from. Files an agent just added are marked new.
 */
export function FilesProperty({
  folders,
  open,
  fresh = false,
  source,
  selected = null,
}: {
  readonly folders: readonly PageFolder[];
  readonly open: boolean;
  /** The files arrived moments ago. */
  readonly fresh?: boolean;
  /** Who added them, shown under the tree. */
  readonly source?: { readonly chat: string; readonly provider: ProviderKind };
  /** The file being pressed or previewed. */
  readonly selected?: string | null;
}) {
  const count = fileCount(folders);
  return (
    <PageProperty icon={<PageIcon />} label="Files">
      {count === 0 ? (
        <span className="px-1 text-app-faint">Empty</span>
      ) : (
        <motion.span
          data-cursor-target="files"
          initial={fresh ? { backgroundColor: "rgb(58 131 247 / 0.22)" } : false}
          animate={{ backgroundColor: "rgb(58 131 247 / 0)" }}
          transition={{ duration: 1.6 }}
          className="inline-flex w-fit items-center gap-1.5 rounded-[5px] px-1 py-0.5 text-app-fg"
        >
          <FolderIcon className="size-[13px] text-app-faint" />
          {count} files
          {fresh && !open ? <span className="size-1.5 rounded-full bg-[#3a83f7]" /> : null}
          <ChevronDownIcon
            className={cx(
              "size-3 text-app-faint transition-transform duration-200",
              !open && "-rotate-90",
            )}
          />
        </motion.span>
      )}
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.32, ease: [0.2, 0.8, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-1.5 mb-1 rounded-[10px] bg-app-fg/[0.025] py-1 ring-[0.5px] ring-app-line ring-inset">
              {folders.map((folder) => (
                <div key={folder.name}>
                  <div className="flex h-[26px] items-center gap-1.5 px-2 text-app-muted">
                    <ChevronDownIcon className="size-3 text-app-faint" />
                    <FolderIcon className="size-[13px] text-app-faint" />
                    <span>{folder.name}</span>
                  </div>
                  {folder.files.map((file, index) => (
                    <motion.div
                      key={file.name}
                      initial={{ opacity: 0, x: -4 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.12 + index * 0.06 }}
                      data-cursor-target={`file:${file.name}`}
                      className={cx(
                        "mx-1 flex h-[27px] items-center gap-1.5 rounded-[6px] pr-2 pl-[30px]",
                        selected === file.name && "bg-app-hover",
                      )}
                    >
                      {PAGE_FILE_ICON[file.kind]}
                      <span className="min-w-0 flex-1 truncate text-app-fg">{file.name}</span>
                      <span className="shrink-0 text-[11px] text-app-faint tabular-nums">
                        {file.size}
                      </span>
                    </motion.div>
                  ))}
                </div>
              ))}
              {source ? (
                <div className="mt-0.5 flex items-center gap-1.5 border-t-[0.5px] border-app-line px-2.5 pt-1.5 pb-0.5 text-[10.5px] text-app-faint">
                  <ProviderMark kind={source.provider} className="size-2.5" />
                  From {source.chat} · now
                </div>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </PageProperty>
  );
}

const COSTS = [
  { label: "Hydrate the whole workspace tree", ms: 1100, color: "#e5652e", fix: 900 },
  { label: "Unsplit charts bundle (840 KB)", ms: 600, color: "#eba13f", fix: 400 },
  { label: "Blocking font request", ms: 300, color: "#e8c547", fix: 200 },
  { label: "Everything else", ms: 300, color: "var(--app-faint)", fix: 0 },
] as const;

const TOTAL = COSTS.reduce((sum, cost) => sum + cost.ms, 0);
const SAVED = COSTS.reduce((sum, cost) => sum + cost.fix, 0);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** The profiling report the agent wrote as HTML, as the Page renders it. */
export function ColdStartReport() {
  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden rounded-[12px] bg-app-fg/[0.02] px-5 py-4 ring-[0.5px] ring-app-line ring-inset">
      <div className="flex flex-col gap-0.5">
        <span className="text-[10px] tracking-[0.08em] text-app-faint uppercase">
          lumen-web · cold start profile
        </span>
        <span className="text-[17px] font-semibold tracking-[-0.01em]">Dashboard cold start</span>
      </div>
      <div className="flex items-end gap-3">
        <span className="flex flex-col">
          <span className="text-[10.5px] text-app-faint">Today</span>
          <span className="text-[28px] leading-none font-semibold tracking-[-0.03em] text-[#e5652e] tabular-nums">
            {seconds(TOTAL)}
          </span>
        </span>
        <span className="pb-1 text-app-faint">→</span>
        <span className="flex flex-col">
          <span className="text-[10.5px] text-app-faint">With the three fixes</span>
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
            <span className="truncate">{cost.label}</span>
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
        <figcaption className="text-[10.5px] text-app-faint">Main thread, first 2.3 s</figcaption>
        <Flamegraph />
      </motion.figure>
      <div className="flex flex-col gap-1.5 border-t-[0.5px] border-app-line pt-3 text-[11px] text-app-muted">
        <span className="font-medium text-app-fg">Suggested fixes</span>
        <span>1. Hydrate the open Project first; load the rest after first paint.</span>
        <span>2. Split the charts bundle by route.</span>
        <span>3. Preload the font and swap it in on load.</span>
      </div>
    </div>
  );
}

/** The profiler screenshot the agent attached, drawn to scale: the full width is 2.3 s. */
export function Flamegraph() {
  const rows = [
    [[0, 100, "#e5652e", "Dashboard cold start · 2.3 s"]],
    [
      [0, 48, "#e8803a", "hydrateWorkspace · 1.1 s"],
      [48, 52, "#e09a3e", "renderDashboard"],
    ],
    [
      [0, 39, "#eba13f", "loadWorkspaceTree"],
      [39, 9, "#d9b14a", "parse"],
      [48, 26, "#e8803a", "charts · 0.6 s"],
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
