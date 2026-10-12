import type { UserConfig } from "vite-plus";

/** Workspace builds leave declared package dependencies external to the bundle. */
export function packageDependencies(manifest: object): readonly string[] {
  return ["dependencies", "peerDependencies", "devDependencies"].flatMap((key) => {
    const entries: unknown = Reflect.get(manifest, key);
    if (entries === null || typeof entries !== "object") return [];
    return Object.keys(entries);
  });
}

/** Dependencies build first; each task emits and restores only its own package. */
export function blocknoteBuildTask(
  dependencies: readonly string[],
): NonNullable<NonNullable<UserConfig["run"]>["tasks"]>[string] {
  const workspaceDependencies = dependencies.filter((name) => name.startsWith("@blocknote/"));
  return {
    // Composite reference configs redirect dependency imports to their declarations.
    // This task's emit is fresh: a retained incremental state cannot hide missing outputs.
    command: "node ../../../../scripts/build-blocknote.mts",
    dependsOn: [{ task: "build", from: ["dependencies", "peerDependencies"] }],
    cache: {
      input: [
        "src/**",
        "*.json",
        "vite.config.ts",
        "../../tsconfig.base.json",
        "../../vite-shared.ts",
        { pattern: "package.json", base: "workspace" },
        { pattern: "pnpm-lock.yaml", base: "workspace" },
        { pattern: "pnpm-workspace.yaml", base: "workspace" },
        { pattern: "scripts/build-blocknote.mts", base: "workspace" },
        ...workspaceDependencies.flatMap((name) => {
          const directory = `../${name.slice("@blocknote/".length)}`;
          return [
            `${directory}/src/**`,
            `${directory}/*.json`,
            `${directory}/types/**`,
            `${directory}/dist/*.css`,
          ];
        }),
      ],
      output: ["dist/**", "types/**"],
    },
  };
}
