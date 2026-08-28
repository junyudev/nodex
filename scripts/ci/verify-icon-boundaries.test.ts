import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test } from "vite-plus/test";

const projectRoot = resolve(import.meta.dirname, "../..");
const tsxCliPath = resolve(projectRoot, "node_modules/tsx/dist/cli.mjs");

describe("icon geometry baseline updater", () => {
  test("verifies against geometry written by the update command", () => {
    const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "nodex-icon-boundary-"));
    const temporaryBaselinePath = resolve(temporaryDirectory, "baseline.json");
    const temporaryRendererRoot = resolve(temporaryDirectory, "src/renderer");
    const temporarySharedIconRoot = resolve(temporaryRendererRoot, "components/shared/icons");
    mkdirSync(temporarySharedIconRoot, { recursive: true });
    writeFileSync(
      resolve(temporarySharedIconRoot, "generic-icons.tsx"),
      `import { Check as LucideCheck } from "lucide-react";\n\nconst createGenericIcon = (source: unknown, name: string) => source;\nexport const Check = createGenericIcon(LucideCheck, "Check");\n`,
    );
    writeFileSync(
      resolve(temporarySharedIconRoot, "fixture-icons.tsx"),
      `type IconProps = { className?: string };\n\nexport function AlphaIcon({ className }: IconProps) {\n  return (\n    <svg width="20" height="20" viewBox="0 0 20 20" className={className ?? "icon-xs"}>\n      <path d="M1 1h2" />\n    </svg>\n  );\n}\n\nexport function BetaIcon({ className }: IconProps) {\n  return (\n    <svg width="20" height="20" viewBox="0 0 20 20" className={className ?? "icon-xs"}>\n      <path d="M1 1h2" />\n    </svg>\n  );\n}\n`,
    );
    mkdirSync(resolve(temporaryRendererRoot, "features"), { recursive: true });
    writeFileSync(
      resolve(temporaryRendererRoot, "features/fixture-consumer.tsx"),
      `import { Check } from "@/components/shared/icons/generic-icons";\n\nexport function FixtureConsumer() {\n  return <Check aria-hidden />;\n}\n`,
    );
    writeFileSync(
      temporaryBaselinePath,
      `${JSON.stringify({ inlineSvg: {}, geometry: [] }, null, 2)}\n`,
    );

    try {
      const result = spawnSync(
        process.execPath,
        [tsxCliPath, "scripts/ci/verify-icon-boundaries.ts", "--update-geometry-baseline"],
        {
          cwd: projectRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            ICON_BOUNDARY_BASELINE_PATH: temporaryBaselinePath,
            ICON_BOUNDARY_RENDERER_ROOT: temporaryRendererRoot,
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

      const refreshed = JSON.parse(readFileSync(temporaryBaselinePath, "utf8")) as {
        geometry: Array<{ owners: string[] }>;
      };
      expect(refreshed.geometry).toHaveLength(1);
      expect(refreshed.geometry[0]?.owners).toEqual([
        expect.stringContaining("#AlphaIcon"),
        expect.stringContaining("#BetaIcon"),
      ]);
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
