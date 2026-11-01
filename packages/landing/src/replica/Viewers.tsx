import type { ReactNode } from "react";
import { cx } from "./Window";
import { ChevronRightLgIcon, DownloadIcon, MoreIcon, PageIcon, ReloadIcon } from "./icons";

// Viewer chrome from viewer-controls.module.css at the demos' 0.82 scale: compact capsules are
// 32px pills on a raised control surface, and the buttons grouped inside one are 28px.
const CAPSULE =
  "flex h-[26.24px] items-center rounded-full bg-app-raised shadow-[0_0_0_0.41px_var(--app-line),0_0.82px_2.46px_#0000000d]";

/**
 * A Page File tab (page-file-viewer.tsx): the path back to its Page, then the file as itself. HTML
 * offers its source and a reload; every file can be saved.
 */
export function PageFileView({
  page,
  path,
  html = false,
  children,
}: {
  readonly page: string;
  /** Folders and the file name, below the Page. */
  readonly path: readonly string[];
  readonly html?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="absolute inset-0 flex flex-col bg-app">
      <div className="flex h-[39.36px] shrink-0 items-center gap-[4.92px] px-[6.56px] text-app-muted">
        <div
          className={cx(CAPSULE, "min-w-0 gap-[4.92px] overflow-hidden px-[8.2px] text-[10.66px]")}
        >
          <span className="flex shrink-0 items-center gap-[3.28px]">
            <PageIcon className="size-[13.12px] text-app-faint" />
            <span className="text-app-muted">{page}</span>
          </span>
          <ChevronRightLgIcon className="size-[11.48px] shrink-0 text-app-faint" />
          <Path segments={path} />
        </div>
        <span className="flex-1" />
        {html ? (
          <>
            <div className={cx(CAPSULE, "shrink-0 px-[9.84px] text-[10.66px] text-app-fg")}>
              View source
            </div>
            <div className={cx(CAPSULE, "w-[26.24px] shrink-0 justify-center")}>
              <ReloadIcon className="size-[13.12px]" />
            </div>
          </>
        ) : null}
        <div className={cx(CAPSULE, "w-[26.24px] shrink-0 justify-center")}>
          <DownloadIcon className="size-[13.12px]" />
        </div>
        <div className={cx(CAPSULE, "w-[26.24px] shrink-0 justify-center")}>
          <MoreIcon className="size-[13.12px]" />
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

function Path({ segments }: { readonly segments: readonly string[] }) {
  return (
    <span className="flex min-w-0 items-center gap-[4.92px] whitespace-nowrap">
      {segments.map((segment, index) =>
        index === segments.length - 1 ? (
          <span key={segment} className="truncate font-medium text-app-fg">
            {segment}
          </span>
        ) : (
          <span key={segment} className="flex min-w-0 items-center gap-[4.92px] text-app-muted">
            <span className="truncate">{segment}</span>
            <ChevronRightLgIcon className="size-[11.48px] shrink-0 text-app-faint" />
          </span>
        ),
      )}
    </span>
  );
}
