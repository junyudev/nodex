import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import type { AgentChoice } from "../demos/lumen";
import { ArrowUpIcon, ChevronDownIcon, PlusIcon } from "./icons";

/**
 * The agent composer floating over a Database View. Asking it something opens a small card above
 * the input with what the agent is doing, so the View it changes stays in sight.
 */
export function AgentDock({
  agent,
  input,
  card = null,
  active = false,
}: {
  readonly agent: AgentChoice;
  /** What the input shows: the placeholder, or text being typed. */
  readonly input?: ReactNode;
  /** The agent's activity for the request just sent. */
  readonly card?: ReactNode;
  /** The input has text to send. */
  readonly active?: boolean;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-3.5 flex justify-center">
      <motion.div
        layout
        transition={{ type: "spring", stiffness: 380, damping: 34 }}
        className="flex w-[520px] max-w-full flex-col overflow-hidden rounded-[19px] bg-app-menu text-[12px] shadow-[0_0_0_0.5px_var(--app-line),0_8px_24px_-8px_rgb(0_0_0/0.18),0_0_20px_rgb(0_0_0/0.05)]"
      >
        <AnimatePresence initial={false}>
          {card ? (
            <motion.div
              key="card"
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="border-b-[0.5px] border-app-line px-3.5 pt-3 pb-2.5"
            >
              {card}
            </motion.div>
          ) : null}
        </AnimatePresence>
        <motion.div layout="position" className="flex h-9 items-center gap-2 py-1 pr-1.5 pl-2.5">
          <PlusIcon className="size-[15px] shrink-0 text-app-faint" />
          <span className="min-w-5 flex-1 truncate">
            {input ?? <span className="text-app-fg/30">Do anything</span>}
          </span>
          <span className="flex shrink-0 items-center gap-0.5">
            {agent.model} <span className="text-app-faint">{agent.effort}</span>
            <ChevronDownIcon className="ml-0.5 size-3 text-app-faint" />
          </span>
          <span
            className={
              active
                ? "ml-1 flex size-6 shrink-0 items-center justify-center rounded-full bg-[#3a83f7] text-white"
                : "ml-1 flex size-6 shrink-0 items-center justify-center rounded-full bg-[#3a83f7]/50 text-white/80"
            }
          >
            <ArrowUpIcon className="size-4" />
          </span>
        </motion.div>
      </motion.div>
    </div>
  );
}
