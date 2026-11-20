import { createServer } from "node:http";
import { beforeAll, afterAll, expect, test } from "vite-plus/test";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchTestElectron } from "../../../scripts/testing/launch-electron";
import { buildVisualGuestAssets } from "../../../config/visual-guest-assets";
import type { VisualFixture } from "../../../tests/fixtures/visual/electron-main";

let directory: string;
beforeAll(async () => {
  mkdirSync(".generated", { recursive: true });
  directory = mkdtempSync(resolve(".generated/visual-integration-"));
  await build({
    bundle: true,
    entryPoints: [resolve("tests/fixtures/visual/electron-main.ts")],
    format: "cjs",
    platform: "node",
    external: ["electron", "oxc-parser", "oxc-transform"],
    outfile: join(directory, "main.cjs"),
    plugins: [
      {
        name: "visual-integration-assets",
        setup(build) {
          build.onResolve({ filter: /^virtual:nodex-visual-assets$/ }, ({ path }) => ({
            path,
            namespace: "visual-fixture",
          }));
          build.onLoad({ filter: /.*/, namespace: "visual-fixture" }, async () => ({
            contents: await buildVisualGuestAssets(process.cwd()),
          }));
        },
      },
    ],
  });
});
afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

const source = `import { scaleLinear } from "d3-scale";
<nodex.Visualize caption="Weekly totals. Source: collected counts."
  sources={{items: {kind: "data", key: "id", data: [{id: "one", value: 2}]}}}
  params={{ visible: {kind: "toggle", value: true} }}>
  {({ items, datum, params, theme }) => <svg width={300} height={96} role="img" aria-label="Weekly totals">
    <text x={8} y={25} fill={theme.foreground}>Label one</text>
    <text x={9} y={25} fill={theme.foreground}>Label two</text>
    {params.visible && <rect {...datum(items[0], "value")} x={180} y={8}
      width={scaleLinear().domain([0, 2]).range([0, 60])(items[0].value)}
      height={20} fill={theme.primary} />}
  </svg>}
</nodex.Visualize>`;

test("admission, source geometry and measured overlap use the offline Visual guest", async () => {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "ELECTRON_RUN_AS_NODE",
    ),
  );
  const app = await launchTestElectron({
    args: [join(directory, "main.cjs"), `--user-data-dir=${directory}/profile`],
    env: environment,
  });
  let requests = 0;
  const probe = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { "Access-Control-Allow-Origin": "*" }).end("sample");
  });
  await new Promise<void>((finish) => probe.listen(0, "127.0.0.1", finish));
  try {
    const page = await app.firstWindow();
    await expect.poll(() => app.evaluate(() => Boolean(globalThis.visualFixture))).toBe(true);
    const grant: Awaited<ReturnType<VisualFixture["admit"]>> = await app.evaluate(() =>
      globalThis.visualFixture.admit(),
    );
    if (!grant) throw new Error("Visual fixture grant was refused");
    await page.evaluate((grant) => {
      const view = document.createElement("webview");
      view.setAttribute("partition", grant.partition);
      view.setAttribute("preload", "file:///unapproved.js");
      view.setAttribute("webpreferences", "nodeIntegration=yes,sandbox=no,contextIsolation=no");
      view.setAttribute("src", grant.url);
      view.addEventListener("did-finish-load", () => {
        document.body.dataset.visualGuestId = String(view.getWebContentsId());
      });
      document.body.append(view);
    }, grant);
    const body = page.locator("body");
    await expect.poll(() => body.getAttribute("data-visual-guest-id")).toMatch(/^\d+$/u);
    const guestId = Number(await body.getAttribute("data-visual-guest-id"));
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("Network probe did not start");
    const info = await app.evaluate(
      (_electron, { id, url }) => globalThis.visualFixture.inspect(id, url),
      { id: guestId, url: `http://127.0.0.1:${address.port}/` },
    );
    expect(info).toMatchObject({
      require: "undefined",
      process: "undefined",
      api: "undefined",
      canReachNetwork: false,
    });
    expect(requests).toBe(0);
    const result = await app.evaluate(
      (_electron, parameters) =>
        globalThis.visualFixture.render(parameters.grant, parameters.source),
      { grant: grant.grant, source },
    );
    expect(result.status).toBe("rendered");
    if (result.status !== "rendered") throw new Error(result.message);
    expect(result.frame.datum).toMatchObject([{ source: "items", key: "one", field: "value" }]);
    expect(result.frame.datum[0].span).toBeDefined();
    expect(result.frame.text.map(({ span }) => source.slice(span.start, span.end))).toEqual([
      "Label one",
      "Label two",
    ]);
    expect(result.frame.diagnostics.map(({ code }) => code)).toContain("text-overlap");

    const report = await app.evaluate(
      (_electron, source) => globalThis.visualFixture.check(source),
      source,
    );
    expect(report.captures.map(({ appearance }) => appearance)).toEqual(["light", "dark"]);
    expect(report.captures[0].png).not.toEqual(report.captures[1].png);
    expect(report.diagnostics.map(({ code }) => code)).toEqual(["text-overlap", "text-overlap"]);
    const fixed = source.replace("x={9} y={25}", "x={8} y={54}");
    const corrected = await app.evaluate(
      (_electron, source) => globalThis.visualFixture.check(source),
      fixed,
    );
    expect(corrected.diagnostics).toEqual([]);

    // A viewBox gives the SVG an aspect ratio but no intrinsic CSS width.
    const responsive = fixed.replace("width={300} height={96}", 'viewBox="0 0 900 96"');
    const preview = await app.evaluate(
      (_electron, parameters) =>
        globalThis.visualFixture.render(parameters.grant, parameters.source),
      { grant: grant.grant, source: responsive },
    );
    expect(preview).toMatchObject({ status: "rendered", frame: { width: 640, height: 69 } });
    const responsiveReport = await app.evaluate(
      (_electron, source) => globalThis.visualFixture.check(source),
      responsive,
    );
    expect(responsiveReport.captures.map(({ frame }) => [frame.width, frame.height])).toEqual([
      [900, 96],
      [900, 96],
    ]);

    // A fixed size wider than the column scales down with its aspect ratio instead of cropping.
    const wide = fixed.replace("width={300} height={96}", "width={960} height={96}");
    const scaled = await app.evaluate(
      (_electron, parameters) =>
        globalThis.visualFixture.render(parameters.grant, parameters.source),
      { grant: grant.grant, source: wide },
    );
    expect(scaled).toMatchObject({ status: "rendered", frame: { width: 640, height: 64 } });

    const stalled = source
      .replace("=> <svg", "=> { while (true) {} return <svg")
      .replace("</svg>}", "</svg>; }}");
    await expect(
      app.evaluate(
        (_electron, parameters) =>
          globalThis.visualFixture.render(parameters.grant, parameters.source),
        { grant: grant.grant, source: stalled },
      ),
    ).rejects.toThrow(/timeout|timed out/i);
    const afterTimeout = await app.evaluate(
      (_electron, source) => globalThis.visualFixture.check(source),
      fixed,
    );
    expect(afterTimeout.captures).toHaveLength(2);
  } finally {
    probe.close();
    await app.close();
  }
});
