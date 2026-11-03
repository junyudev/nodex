import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Reuse the app's vector mark and the pinned packager's portable SVG-to-ICO converter. */
export async function syncWindowsTrayIcons(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const source = await readFile(join(root, "resources/nodex-icon.svg"), "utf8");
  const require = createRequire(import.meta.url);
  const builder = createRequire(require.resolve("electron-builder"));
  const { convertIcon } = builder(
    join(dirname(builder.resolve("app-builder-lib/package.json")), "out/util/iconConverter.js"),
  ) as {
    convertIcon: (input: {
      sources: string[];
      fallbackSources: string[];
      roots: string[];
      format: "ico";
      outDir: string;
    }) => Promise<{ icons: { file: string }[] }>;
  };
  const temporary = await mkdtemp(join(tmpdir(), "nodex-tray-icons-"));
  try {
    for (const theme of ["light", "dark"] as const) {
      const svg = join(temporary, `tray-${theme}.svg`);
      const themed =
        theme === "dark"
          ? source
          : source.replaceAll('"white"', '"#000000"').replaceAll('"#262626"', '"white"');
      await writeFile(svg, themed);
      const { icons } = await convertIcon({
        sources: [svg],
        fallbackSources: [],
        roots: [temporary],
        format: "ico",
        outDir: temporary,
      });
      const icon = icons[0];
      if (!icon) throw new Error(`No ${theme} tray icon was generated`);
      // Windows build checkouts and the OS temporary directory can use different volumes.
      await copyFile(icon.file, join(root, "resources/windows", `tray-${theme}.ico`));
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void syncWindowsTrayIcons().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
