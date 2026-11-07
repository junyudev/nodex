import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { DASHBOARD_NAME, DASHBOARD_WIDGETS } from "./product-dashboard";
import { requireSuccess, statsigConsole } from "./statsig-console";

/** Creates or converges the product dashboard. Safe to run repeatedly. */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const api = statsigConsole();
  const dashboards = requireSuccess("List dashboards", await api.get("/dashboards")) as readonly {
    readonly id: string;
    readonly name: string;
  }[];
  const existing = dashboards.find((dashboard) => dashboard.name === DASHBOARD_NAME);
  const definition = {
    description:
      "Installations, active use, conversations and releases. Provisioned from the Nodex repository.",
    defaults: { date: { value: 1, unit: "month" }, granularity: "daily" },
  };

  let id = existing?.id;
  if (id) {
    // Statsig reconciles by widget ID against a read revision: keep what still exists by title,
    // and name exactly what goes away.
    const editable = requireSuccess(
      "Read dashboard",
      await api.get(`/dashboards/${id}?view=editable`),
    ) as {
      readonly revision: string;
      readonly widgets: readonly { readonly id: string; readonly title: string }[];
    };
    const idsByTitle = new Map(editable.widgets.map((widget) => [widget.title, widget.id]));
    const wanted = new Set(DASHBOARD_WIDGETS.map((widget) => widget.title));
    requireSuccess(
      "Replace dashboard widgets",
      await api.put(`/dashboards/${id}/widgets`, {
        revision: editable.revision,
        widgets: DASHBOARD_WIDGETS.map((widget) => {
          const existingId = idsByTitle.get(widget.title);
          return existingId ? { ...widget, id: existingId } : widget;
        }),
        delete_widget_ids: editable.widgets
          .filter((widget) => !wanted.has(widget.title))
          .map((widget) => widget.id),
      }),
    );
  } else {
    const created = requireSuccess(
      "Create dashboard",
      await api.post("/dashboards", {
        name: DASHBOARD_NAME,
        ...definition,
        widgets: DASHBOARD_WIDGETS,
      }),
    ) as { readonly id: string };
    id = created.id;
  }

  const output = `${JSON.stringify(
    { dashboardId: id, created: existing === undefined, widgets: DASHBOARD_WIDGETS.length },
    null,
    2,
  )}\n`;
  if (values.out) writeFileSync(values.out, output);
  process.stdout.write(output);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
