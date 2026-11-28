import { readFile } from "node:fs/promises";
import { createIntl } from "@formatjs/intl";
import { sharePeriodLabel } from "@nodex/insights-cards";
import zhCN from "@nodex/insights-cards/catalogs/zh-CN.json";

import { ArgumentError, localToday, resolveArgs } from "./args";
import { ccusageCardView } from "./ccusage/adapter";
import { readCcusage } from "./ccusage/run";
import { detectLocale, terminal } from "./locale";
import { openBrowser } from "./open-browser";
import { embedPreviewData } from "./page/data";
import { servePreview } from "./server";
import { terminalSummary } from "./summary";
import { version } from "../package.json";

/** Says what is happening while history is read; a terminal sees it spin, a log sees one line. */
function startProgress(text: string): () => void {
  if (!process.stderr.isTTY) {
    console.log(text);
    return () => {};
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frame = 0;
  const draw = () => {
    process.stderr.write(`\r\u001b[2K  ${frames[frame % frames.length]} ${text}`);
    frame += 1;
  };
  draw();
  const timer = setInterval(draw, 100);
  timer.unref();
  return () => {
    clearInterval(timer);
    process.stderr.write("\r\u001b[2K");
  };
}

const locale = detectLocale(process.env);
const messages = terminal[locale];

function printError(message: string, error: unknown) {
  const detail = error instanceof Error ? ` ${error.message}` : "";
  console.error(message + detail);
}

async function main(): Promise<void> {
  const args = resolveArgs(process.argv.slice(2), localToday(), locale);
  if (args.command === "help") {
    console.log(messages.help);
    return;
  }
  if (args.command === "version") {
    console.log(version);
    return;
  }

  const stop = new AbortController();
  const shutdown = () => stop.abort();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const { firstDay, lastDay, period } = args;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const stopSpinner = startProgress(messages.reading);
  const report = await readCcusage({
    since: firstDay,
    until: lastDay,
    timeZone,
    cost: args.cost,
  })
    .catch((error: unknown) => {
      if (stop.signal.aborted) return null;
      throw error;
    })
    .finally(stopSpinner);

  if (!report || stop.signal.aborted) return;

  const view = ccusageCardView(report, { period, firstDay, lastDay });
  // The terminal says what the cards will say, in the same words and numbers.
  const intl = createIntl({
    locale,
    defaultLocale: "en-US",
    messages: locale === "zh-CN" ? zhCN : {},
  });
  if (view.tokens === 0) {
    console.log(messages.empty(sharePeriodLabel(view, intl)));
    return;
  }

  const hasCost = args.cost && view.costUsd > 0;
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  console.log(
    terminalSummary(view, intl, {
      showCost: hasCost,
      color,
      width: Math.min(process.stdout.columns || 80, 88),
    }),
  );
  if (args.cost && !hasCost) console.log(`  ${messages.noPrice}`);

  try {
    const template = await readFile(new URL("./preview.html", import.meta.url), "utf8");
    const html = embedPreviewData(template, { view, locale, name: args.name, hasCost });
    const url = await servePreview(html, stop.signal);
    console.log(`  ${messages.preview(url)}\n`);
    if (args.open) openBrowser(url, () => console.error(messages.openFailed(url)));
  } catch (error) {
    if (stop.signal.aborted) return;
    printError(messages.previewFailed, error);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof ArgumentError) {
    console.error(error.message);
    process.exitCode = 2;
  } else {
    printError(messages.readFailed, error);
    process.exitCode = 1;
  }
}
