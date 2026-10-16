export type NodeBuildMode = "development" | "production";

/** Keep reflective names and offline diagnostics while shrinking shipped Node programs. */
export const nodeBuildOptimizationArguments = (mode: NodeBuildMode): readonly string[] =>
  mode === "production" ? ["--minify", "--keep-names", "--sourcemap=external"] : [];
