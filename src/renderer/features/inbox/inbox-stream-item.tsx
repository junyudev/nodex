import type { ReactNode } from "react";
import { motion, useIsPresent } from "motion/react";
import { cn } from "@/lib/utils";

/** The Inbox's one easing: quick to start, gentle to land. */
export const INBOX_EASE_OUT = [0.2, 0, 0, 1] as const;

/**
 * One message in the stream. A handled message folds away, which is what clearing the Inbox
 * feels like. Only that fold clips, so a selected card's ring and the focus rings at the edges
 * of its row are never cut while the message is shown.
 */
export function InboxStreamItem({ children }: { readonly children: ReactNode }) {
  const present = useIsPresent();
  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0, scale: 0.98 }}
      transition={{ duration: 0.28, ease: INBOX_EASE_OUT }}
      className={cn("origin-top pb-4", !present && "overflow-hidden")}
    >
      {children}
    </motion.div>
  );
}
