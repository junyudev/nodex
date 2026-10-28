import type { ReactNode } from "react";
import { cx } from "./Window";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  MoreIcon,
  PageIcon,
  ReloadIcon,
} from "./icons";

// Viewer chrome from viewer-controls.module.css at the demos' 0.82 scale: compact capsules are
// 32px pills on a raised control surface, and the buttons grouped inside one are 28px.
const CAPSULE =
  "flex h-[26.24px] shrink-0 items-center rounded-full bg-app-raised shadow-[0_0_0_0.41px_var(--app-line),0_0.82px_2.46px_#0000000d]";

function ControlButton({
  children,
  disabled = false,
}: {
  readonly children: ReactNode;
  readonly disabled?: boolean;
}) {
  return (
    <span
      className={cx(
        "flex size-[22.96px] items-center justify-center rounded-full [&>svg]:size-[14.76px]",
        disabled && "opacity-40",
      )}
    >
      {children}
    </span>
  );
}

/** A browser tab (browser-sidebar-panel.tsx): navigation, a centred address, then the page. */
export function BrowserView({
  address,
  children,
}: {
  /** Path segments to the page; the last one reads strongest. */
  readonly address: readonly string[];
  readonly children: ReactNode;
}) {
  return (
    <div className="absolute inset-0 flex flex-col bg-app">
      <div className="flex h-[34.44px] shrink-0 items-center gap-[4.92px] border-b border-app-line px-[6.56px] text-app-muted">
        <div className={cx(CAPSULE, "p-[1.64px]")}>
          <ControlButton>
            <ArrowLeftIcon />
          </ControlButton>
          <ControlButton disabled>
            <ArrowRightIcon />
          </ControlButton>
          <span className="mx-[1.64px] h-[13.12px] w-px bg-app-line" />
          <ControlButton>
            <ReloadIcon />
          </ControlButton>
        </div>
        <div
          className={cx(
            CAPSULE,
            "min-w-0 flex-1 justify-center gap-[4.92px] px-[9.84px] text-[10.66px]",
          )}
        >
          <PageIcon className="size-[13.12px] shrink-0 text-app-faint" />
          <Path segments={address} />
        </div>
        <ControlButton>
          <MoreIcon />
        </ControlButton>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

/** A file tab (workspace-file-viewer-header.tsx): its path, an Open menu, then the file. */
export function FileView({
  path,
  icon,
  children,
}: {
  readonly path: readonly string[];
  readonly icon: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="absolute inset-0 flex flex-col bg-app">
      <div className="flex h-[39.36px] shrink-0 items-center gap-[6.56px] px-[6.56px]">
        <div className={cx(CAPSULE, "min-w-0 gap-[4.92px] px-[9.84px] text-[10.66px]")}>
          <span className="flex shrink-0 [&>svg]:size-[13.12px]">{icon}</span>
          <Path segments={path} />
        </div>
        <div className={cx(CAPSULE, "ml-auto gap-[3.28px] pr-[6.56px] pl-[9.84px] text-[10.66px]")}>
          Open
          <ChevronDownIcon className="size-[11.48px] text-app-faint" />
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
          <span key={segment} className="flex min-w-0 items-center gap-[4.92px] text-app-faint">
            <span className="truncate">{segment}</span>
            <span>/</span>
          </span>
        ),
      )}
    </span>
  );
}
