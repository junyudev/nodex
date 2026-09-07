import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  AGENT_CLI_PAGE_KEY,
  AGENT_CLI_PAGE_TITLE,
  AGENT_CLI_PROJECT_NAME,
  AGENT_CLI_SCENARIO_ID,
} from "../../scripts/scenarios/scenarios/agent-cli-workflow";

interface CliResult<T> {
  readonly ok: boolean;
  readonly result: T;
}
interface PropertyState {
  readonly data_source_id: string;
  readonly values: Record<string, unknown>;
  readonly value_revisions: Record<string, number>;
}
interface SourceSchema {
  readonly schema_revision: number;
  readonly properties: readonly {
    readonly id: string;
    readonly schema: { readonly kind: string };
    readonly name: string;
  }[];
}

const cli = (home: string, cwd: string, args: readonly string[], input?: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = execFile(
      path.resolve(process.env.NODEX_PACKAGED_CLI ?? "target/debug/nodex"),
      [...args],
      {
        cwd,
        env: { ...process.env, NODEX_HOME: home },
        maxBuffer: 8 * 1024 * 1024,
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${args.join(" ")}: ${stderr}`, { cause: error }));
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin?.end(input);
  });

const parseResult = <T>(text: string): T => {
  const envelope = JSON.parse(text) as CliResult<T>;
  expect(envelope.ok).toBe(true);
  return envelope.result;
};

test("direct Agent commands update the same Page, properties, and attachments shown in Nodex", async ({}, testInfo) => {
  test.setTimeout(150_000);
  await withElectronScenario(
    {
      label: "agent-cli-workflow",
      scenarioId: AGENT_CLI_SCENARIO_ID,
      onFailure: async ({ page, readRuntimeLogs }) => {
        await testInfo.attach("runtime", {
          body: Buffer.from(await readRuntimeLogs()),
          contentType: "text/plain",
        });
        if (page)
          await testInfo.attach("page", {
            body: await page.screenshot(),
            contentType: "image/png",
          });
      },
    },
    async ({ page, profile, manifest }) => {
      if (!manifest) throw new Error("Agent CLI scenario was not seeded");
      const pageId = manifest.pageIdsByKey[AGENT_CLI_PAGE_KEY];
      if (!pageId) throw new Error("Meeting Page is missing");
      const run = (args: readonly string[], input?: string) =>
        cli(profile.nodexHome, profile.initialProjectsDirectory, args, input);
      const structured = async <T>(args: readonly string[], input?: string): Promise<T> =>
        parseResult<T>(await run(args, input));

      const context = await structured<{ project: { id: string } }>(["context"]);
      expect(context.project.id).toBe(manifest.projectId);
      const help = JSON.parse(await run(["--json", "page", "insert", "--help"])) as {
        schemaVersion: number;
      };
      expect(help.schemaVersion).toBe(3);
      const matches = await structured<{ items: readonly { page_id: string }[] }>([
        "search",
        "Release meeting",
      ]);
      expect(matches.items.some((item) => item.page_id === pageId)).toBe(true);
      const original = await run(["read", pageId]);
      expect(original).toContain("Release date: Friday.");

      await page
        .getByRole("button", { name: `Open ${AGENT_CLI_PROJECT_NAME}`, exact: true })
        .click();
      const card = page.locator(
        `[data-board-uuid-v7="${pageId}"] [data-card-context-menu-trigger="true"]`,
      );
      await card.evaluate((element) => (element as HTMLElement).click());
      await page.getByRole("tab", { name: AGENT_CLI_PAGE_TITLE, exact: true }).waitFor();
      const stage = page.locator(`[data-page-stage-page-id="${pageId}"]:visible`);
      await expect(stage.getByText("Release date: Friday.", { exact: true })).toBeVisible();

      await run(
        ["page", "insert", pageId],
        "\n## Action items\n\nUpdate the installation guide.\n",
      );
      await run(
        ["patch"],
        `*** Begin Patch\n*** Update Page: ${pageId}\n@@\n-Release date: Friday.\n+Release date: Monday.\n*** End Patch\n`,
      );
      await expect(stage.getByText("Release date: Monday.", { exact: true })).toBeVisible();
      await expect(
        stage.getByText("Update the installation guide.", { exact: true }),
      ).toBeVisible();
      await expect(
        stage.getByText("Keep the rollback checklist intact.", { exact: true }),
      ).toBeVisible();

      const propertyState = await structured<PropertyState>(["page", "properties", "get", pageId]);
      const schema = await structured<SourceSchema>([
        "data-source",
        "describe",
        propertyState.data_source_id,
      ]);
      const status = schema.properties.find((property) => property.name.toLowerCase() === "status");
      if (!status) throw new Error("Scenario status schema was not discovered");
      const options = await structured<{
        items: readonly { id: string; name: string }[];
      }>(["data-source", "options", propertyState.data_source_id, "--property", status.id]);
      const target = options.items.find((option) => option.name.toLowerCase() === "review");
      if (!target) throw new Error("Review option was not discovered");
      const revision = propertyState.value_revisions[status.id];
      if (revision === undefined) throw new Error("Property value revision is missing");
      await run([
        "page",
        "properties",
        "set",
        pageId,
        "--property",
        status.id,
        "--option",
        target.id,
        "--if-revision",
        String(revision),
      ]);
      const query = await structured<{
        items: readonly { page_id: string }[];
        returned_count: number;
      }>(
        ["data-source", "query", propertyState.data_source_id, "--input", "-"],
        JSON.stringify({
          filter: { kind: "group", operator: "and", children: [] },
          sort: [],
          limit: 50,
        }),
      );
      expect(query.items.some((row) => row.page_id === pageId)).toBe(true);
      await expect(stage.getByText("Review", { exact: true }).first()).toBeVisible();

      const group = await structured<{
        items: readonly { page_id: string }[];
        returned_count: number;
      }>(["view", "query", "--group", "Review"]);
      expect(group.items.map((item) => item.page_id)).toEqual([pageId]);
      expect(group.returned_count).toBe(1);
      const count = await structured<{
        columns: readonly string[];
        rows: readonly (readonly number[])[];
      }>(["sql", "query", "SELECT count(*) AS matched_count FROM pages"]);
      expect(count.columns).toEqual(["matched_count"]);
      expect(count.rows).toEqual([[1]]);

      const script = JSON.stringify({
        if_schema_revision: schema.schema_revision,
        operations: [
          {
            kind: "add_property",
            name: "Risk",
            schema: { kind: "select" },
            options: ["Low", "High"],
          },
          { kind: "create_view", name: "Risk board", layout: "board", group_by: "Risk" },
        ],
      });
      const configure = [
        "data-source",
        "configure",
        "--input",
        "-",
        "--idempotency-key",
        "agent-workflow-config",
      ];
      await run(configure, script);
      await run(configure, script);
      const views = await structured<{ items: readonly { name: string }[] }>(["view", "list"]);
      expect(views.items.filter((view) => view.name === "Risk board")).toHaveLength(1);
      const risks = await structured<{ items: readonly { id: string; name: string }[] }>([
        "data-source",
        "options",
        propertyState.data_source_id,
        "--property",
        "Risk",
      ]);
      const low = risks.items.find((option) => option.name === "Low");
      if (!low) throw new Error("Risk option is missing");
      const selection = await run([
        "sql",
        "query",
        "SELECT page_id, data_source_id FROM pages WHERE title = :title",
        "--param",
        `title=${JSON.stringify(AGENT_CLI_PAGE_TITLE)}`,
      ]);
      const edits = await run(
        [
          "page",
          "properties",
          "prepare-batch",
          "--selection",
          "-",
          "--set",
          `Risk=${JSON.stringify({ kind: "select", option_id: low.id })}`,
        ],
        selection,
      );
      await run(["page", "properties", "apply", "--input", "-"], edits);
      const riskGroup = await structured<{ items: readonly { page_id: string }[] }>([
        "view",
        "query",
        "Risk board",
        "--group",
        "Low",
      ]);
      expect(riskGroup.items.map((item) => item.page_id)).toEqual([pageId]);
      await testInfo.attach("agent-query-evidence", {
        body: Buffer.from(
          JSON.stringify({
            group_query_calls: 1,
            returned_count: group.returned_count,
            group_result_bytes: Buffer.byteLength(JSON.stringify(group)),
            sql_count: count.rows[0]?.[0],
            selected_pages: riskGroup.items.length,
          }),
        ),
        contentType: "application/json",
      });

      const inventory = await structured<{ revision: number }>(["page", "file", "list", pageId]);
      const csv = "owner,action\nLin,Update installation guide\n";
      const source = path.join(profile.runRoot, "action-summary.csv");
      await writeFile(source, csv);
      await run([
        "page",
        "file",
        "put",
        pageId,
        "--path",
        "action-summary.csv",
        "--from",
        source,
        "--if-manifest",
        String(inventory.revision),
      ]);
      expect(await run(["page", "file", "read", pageId, "--path", "action-summary.csv"])).toBe(csv);
      const finalInventory = await structured<{
        files: readonly { logical_path: string | null }[];
      }>(["page", "file", "list", pageId]);
      expect(finalInventory.files.some((file) => file.logical_path === "action-summary.csv")).toBe(
        true,
      );
      await testInfo.attach("cli-result", {
        body: Buffer.from(await run(["read", pageId])),
        contentType: "text/markdown",
      });
    },
  );
});
