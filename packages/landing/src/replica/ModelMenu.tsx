import { AnimatePresence, motion, type MotionValue } from "motion/react";
import type { ReactNode } from "react";
import type { CatalogModel } from "../demos/lumen";
import { ProviderMark, cx } from "./Window";
import { CheckIcon, FastModeIcon, RefreshIcon, SearchIcon, SettingsIcon } from "./icons";

/**
 * The model menu shared by the composer and the Inbox (AgentModelPicker): a search field, every
 * provider's models with the current one checked, then effort. It opens above its trigger,
 * aligned to its end, 8px away. Its surface is solid: a blurred backdrop is lost under the
 * Inbox's faded edge, and the app's translucent menu reads as solid anyway.
 */
export function ModelMenu({
  models,
  listKey,
  chosen,
  pick,
  query,
  queryPlaceholderOpacity,
  listHeight = 250,
  actions,
}: {
  /** The rows the search leaves. */
  readonly models: readonly CatalogModel[];
  /** Changes when the search narrows the list, so the rows cross-fade. */
  readonly listKey: string;
  readonly chosen: string;
  /** The row the pointer is heading for, and whether it is over it yet. */
  readonly pick?: { readonly name: string; readonly target: string; readonly hovered: boolean };
  readonly query: MotionValue<string>;
  readonly queryPlaceholderOpacity: MotionValue<number>;
  readonly listHeight?: number;
  /** Rows after Show all models, such as the Inbox's Use for all Inbox chats. */
  readonly actions?: ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.18 }}
      className="absolute right-0 bottom-[calc(100%+8px)] z-10 flex w-[288px] flex-col rounded-[15px] bg-app-menu p-1 text-left text-[13px] leading-[18.5714px] text-app-fg shadow-[0_8px_24px_rgb(0_0_0/0.12)] ring-[0.5px] ring-app-line [corner-shape:superellipse(1.5)]"
    >
      <div className="flex h-8 shrink-0 items-center gap-2 px-2 text-app-faint">
        <SearchIcon className="size-3" />
        <span className="min-w-0 flex-1">
          <motion.span className="text-app-fg">{query}</motion.span>
          <motion.span style={{ opacity: queryPlaceholderOpacity }}>Search models…</motion.span>
        </span>
        <span className="flex items-center">
          <span className="flex size-6 items-center justify-center" aria-label="Refresh models">
            <RefreshIcon className="size-3.5" />
          </span>
          <span className="flex size-6 items-center justify-center" aria-label="Manage providers">
            <SettingsIcon className="size-3.5" />
          </span>
        </span>
      </div>
      <AnimatePresence initial={false} mode="wait">
        <motion.div
          key={listKey}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          // The menu opens with the current model in view.
          ref={(node) => {
            const selected = node?.querySelector<HTMLElement>("[data-selected-model]");
            if (!node || !selected) return;
            node.scrollTop += Math.max(
              0,
              selected.getBoundingClientRect().bottom - node.getBoundingClientRect().bottom,
            );
          }}
          className="flex flex-col overflow-y-auto [scrollbar-width:thin]"
          style={{ height: listHeight }}
        >
          {models.map((model) => (
            <div
              key={model.name}
              data-selected-model={model.name === chosen ? "" : undefined}
              data-cursor-target={model.name === pick?.name ? pick.target : undefined}
              className={cx(
                "flex shrink-0 items-center gap-2 rounded-[12.5px] px-2 py-[5px]",
                model.name === pick?.name && pick.hovered && "bg-app-hover",
              )}
            >
              <ProviderMark kind={model.provider} className="size-3.5" />
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="truncate">{model.name}</span>
                {model.provider === "opencode" ? (
                  <span className="min-w-0 truncate text-[12px] leading-4 text-app-muted">
                    OpenCode
                  </span>
                ) : null}
              </span>
              {model.name === chosen ? (
                <CheckIcon className="ml-auto size-3.5 text-app-muted" />
              ) : null}
            </div>
          ))}
        </motion.div>
      </AnimatePresence>
      <div className="mx-2 my-1 border-t border-app-line" />
      <div className="px-2 py-[5px]">Show all models</div>
      {actions}
      <div className="mx-2 my-1 border-t border-app-line" />
      <div className="flex flex-col gap-1 px-2 pt-0.5 pb-2">
        <div className="flex min-h-7 items-center gap-1.5 text-[13px]">
          <span className="font-medium text-[#3a83f7]">High</span>
          <span
            className="ml-auto flex size-7 items-center justify-center text-app-muted"
            aria-label="Fast · Off"
          >
            <FastModeIcon className="size-3" />
          </span>
        </div>
        <div className="relative mx-0 h-7">
          <div className="absolute inset-x-0 top-1/2 h-6 -translate-y-1/2 rounded-full bg-app-fg/[0.08] ring-[0.5px] ring-app-line" />
          <div className="absolute top-1/2 left-0 h-6 w-[calc(50%+14px)] -translate-y-1/2 rounded-full bg-[#3a83f7]" />
          <div className="absolute inset-x-3.5 top-1/2 flex -translate-y-1/2 justify-between">
            {[0, 1, 2, 3, 4].map((stop) => (
              <span
                key={stop}
                className={cx("size-1 rounded-full", stop <= 2 ? "bg-white/45" : "bg-app-fg/25")}
              />
            ))}
          </div>
          <span className="absolute top-1/2 left-1/2 size-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-[0.5px] border-app-line bg-white shadow-[0_0_2px_rgb(0_0_0/0.1),0_1px_3px_rgb(0_0_0/0.08)]" />
        </div>
      </div>
    </motion.div>
  );
}
