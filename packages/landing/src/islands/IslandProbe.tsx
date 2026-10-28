import { motion } from "motion/react";

// Temporary hydration probe, replaced by the homepage's interactive demos.
export default function IslandProbe() {
  return (
    <motion.span
      aria-hidden="true"
      data-island-probe
      className="mt-4 block size-1 rounded-full bg-current opacity-40"
      initial={{ scale: 0.5 }}
      animate={{ scale: 1 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
    />
  );
}
