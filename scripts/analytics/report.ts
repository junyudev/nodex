import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { DASHBOARD_NAME } from "./product-dashboard";
import { requireSuccess, statsigConsole } from "./statsig-console";

interface Point {
  readonly time: string;
  readonly value: number | null;
}
interface WidgetResult {
  readonly timeseries?: {
    readonly datasets: readonly {
      readonly label?: string | null;
      readonly group?: string | null;
      readonly points: readonly Point[];
    }[];
  };
  readonly funnel?: {
    readonly datasets: readonly {
      readonly steps: readonly { readonly name: string; readonly count: number }[];
    }[];
  };
}

/** Reads the same dashboard people look at, so the terminal and the console cannot disagree. */
export const summarizeWidget = (result: WidgetResult): readonly string[] => {
  if (result.funnel) {
    const steps = result.funnel.datasets[0]?.steps ?? [];
    return [steps.map((step) => `${step.name} ${step.count}`).join(" -> ")];
  }
  return (result.timeseries?.datasets ?? []).map((dataset) => {
    const values = dataset.points.map((point) => point.value ?? 0);
    const label = dataset.group ?? dataset.label ?? "all";
    const total = values.reduce((sum, value) => sum + value, 0);
    return `${label}: latest ${values.at(-1) ?? 0}, previous ${values.at(-2) ?? 0}, total ${total}`;
  });
};

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const api = statsigConsole();
  const dashboards = requireSuccess("List dashboards", await api.get("/dashboards")) as readonly {
    readonly id: string;
    readonly name: string;
  }[];
  const dashboard = dashboards.find((candidate) => candidate.name === DASHBOARD_NAME);
  if (!dashboard) throw new Error(`${DASHBOARD_NAME} is not provisioned; run analytics:provision.`);
  const { widgets } = requireSuccess(
    "Read dashboard",
    await api.get(`/dashboards/${dashboard.id}`),
  ) as {
    readonly widgets: readonly {
      readonly id: string;
      readonly title: string;
      readonly type: string;
    }[];
  };
  const lines: string[] = [`${DASHBOARD_NAME} (https://console.statsig.com, last 30 days, daily)`];
  for (const widget of widgets) {
    if (widget.type === "header") {
      lines.push("", `# ${widget.title}`);
      continue;
    }
    const response = await api.get(
      `/dashboards/${dashboard.id}/widgets/${widget.id}/results?sampling_enabled=false`,
    );
    const summary =
      response.status === 200
        ? summarizeWidget(response.body.data as WidgetResult)
        : [`unavailable (${response.status})`];
    lines.push(widget.title, ...summary.map((line) => `  ${line}`));
  }
  const output = `${lines.join("\n")}\n`;
  if (values.out) writeFileSync(values.out, output);
  process.stdout.write(output);
}

if (process.argv[1]?.endsWith("report.ts")) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
