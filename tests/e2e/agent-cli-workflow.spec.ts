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
interface SqlResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  readonly returned_count: number;
  readonly snapshot: string;
}
interface SourceSchema {
  readonly tables: readonly {
    readonly columns: readonly {
      readonly name: string;
      readonly property_id: string | null;
      readonly options: readonly { readonly id: string; readonly name: string }[];
    }[];
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

      const sql = async <T>(
        statement: string,
        params: Record<string, unknown> = {},
        bindings: readonly string[] = [],
      ): Promise<readonly T[]> => {
        const result = await structured<SqlResult>([
          "sql",
          "query",
          statement,
          ...Object.entries(params).flatMap(([name, value]) => [
            "--param",
            `${name}=${JSON.stringify(value)}`,
          ]),
          ...bindings.flatMap((binding) => ["--bind", binding]),
        ]);
        expect(result.returned_count).toBe(result.rows.length);
        expect(result.snapshot.length).toBeGreaterThan(0);
        return result.rows.map(
          (row) => Object.fromEntries(result.columns.map((name, index) => [name, row[index]])) as T,
        );
      };
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
      const original = await run([
        "sql",
        "query",
        "SELECT nested_markdown FROM page_documents WHERE page_id=:id",
        "--param",
        `id=${JSON.stringify(pageId)}`,
        "--raw",
      ]);
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

      const [source] = await sql<{
        data_source_id: string;
        schema_revision: number;
        default_view_id: string;
      }>(
        "SELECT s.data_source_id,s.schema_revision,d.default_view_id FROM pages p JOIN data_sources s USING(data_source_id) JOIN databases d ON d.database_id=s.database_id WHERE p.page_id=:id",
        { id: pageId },
      );
      if (!source) throw new Error("Scenario Source was not discovered");
      const binding = `tasks=${source.data_source_id}`;
      const bindings = [binding];
      const schema = await structured<SourceSchema>(["sql", "schema", "tasks", "--bind", binding]);
      const status = schema.tables[0]?.columns.find(
        (column) => column.name.toLowerCase() === "status",
      );
      if (!status?.property_id) throw new Error("Scenario status schema was not discovered");
      const target = status.options.find((option) => option.name.toLowerCase() === "review");
      if (!target) throw new Error("Review option was not discovered");
      const [observed] = await sql<{ value_revision: number }>(
        "SELECT value_revision FROM property_values WHERE page_id=:page AND property_id=:property",
        { page: pageId, property: status.property_id },
      );
      if (!observed) throw new Error("Property value revision is missing");
      const revision = observed.value_revision;
      await run([
        "page",
        "properties",
        "set",
        pageId,
        "--property",
        status.property_id,
        "--option",
        target.id,
        "--if-revision",
        String(revision),
      ]);
      const query = await sql<{ page_id: string }>(
        "SELECT page_id FROM tasks ORDER BY page_id",
        {},
        bindings,
      );
      expect(query.some((row) => row.page_id === pageId)).toBe(true);
      await expect(stage.getByText("Review", { exact: true }).first()).toBeVisible();
      const group = await sql<{ page_id: string }>(
        "SELECT page_id FROM view_rows(:view) WHERE group_key=:group ORDER BY ordinal",
        { view: source.default_view_id, group: target.id },
      );
      expect(group.map((item) => item.page_id)).toEqual([pageId]);
      const count = await sql<{ matched_count: number }>(
        "SELECT count(*) AS matched_count FROM tasks",
        {},
        bindings,
      );
      expect(count).toEqual([{ matched_count: 1 }]);
      const documents = await sql<{ page_id: string; nested_markdown: string; body_etag: string }>(
        "SELECT t.page_id,d.nested_markdown,d.body_etag FROM tasks t JOIN page_documents d USING(page_id) ORDER BY t.page_id",
        {},
        bindings,
      );
      expect(documents).toHaveLength(1);
      expect(documents[0]?.nested_markdown).toContain("Release date: Monday.");
      expect(documents[0]?.body_etag).toBeTruthy();

      const script = JSON.stringify({
        if_schema_revision: source.schema_revision,
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
      const views = await sql<{ view_id: string; name: string }>(
        "SELECT view_id,name FROM views WHERE data_source_id=:id AND name='Risk board'",
        { id: source.data_source_id },
      );
      expect(views).toHaveLength(1);
      const riskView = views[0];
      if (!riskView) throw new Error("Risk View is missing");
      const risks = await sql<{ option_id: string; name: string }>(
        "SELECT o.option_id,o.name FROM property_options o JOIN properties p USING(data_source_id,property_id) WHERE p.data_source_id=:id AND p.name='Risk'",
        { id: source.data_source_id },
      );
      const low = risks.find((option) => option.name === "Low");
      if (!low) throw new Error("Risk option is missing");
      const selection = await run([
        "sql",
        "query",
        "SELECT page_id, data_source_id, membership_revision, value_revisions FROM tasks WHERE title = :title",
        "--bind",
        binding,
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
          `Risk=${JSON.stringify({ kind: "select", option_id: low.option_id })}`,
        ],
        selection,
      );
      await run(["page", "properties", "apply", "--input", "-"], edits);
      const riskGroup = await sql<{ page_id: string }>(
        "SELECT page_id FROM view_rows(:view) WHERE group_key=:group ORDER BY ordinal",
        { view: riskView.view_id, group: low.option_id },
      );
      expect(riskGroup.map((item) => item.page_id)).toEqual([pageId]);
      await testInfo.attach("agent-query-evidence", {
        body: Buffer.from(
          JSON.stringify({
            group_query_calls: 1,
            returned_count: group.length,
            group_result_bytes: Buffer.byteLength(JSON.stringify(group)),
            sql_count: count[0]?.matched_count,
            selected_pages: riskGroup.length,
          }),
        ),
        contentType: "application/json",
      });

      const [inventory] = await sql<{ file_manifest_revision: number }>(
        "SELECT file_manifest_revision FROM pages WHERE page_id=:id",
        { id: pageId },
      );
      if (!inventory) throw new Error("Page manifest observation is missing");
      const csv = "owner,action\nLin,Update installation guide\n";
      const sourceFile = path.join(profile.runRoot, "action-summary.csv");
      await writeFile(sourceFile, csv);
      await run([
        "page",
        "file",
        "put",
        pageId,
        "--path",
        "action-summary.csv",
        "--from",
        sourceFile,
        "--if-manifest",
        String(inventory.file_manifest_revision),
      ]);
      expect(await run(["page", "file", "read", pageId, "--path", "action-summary.csv"])).toBe(csv);
      const finalInventory = await sql<{ path: string | null }>(
        "SELECT path FROM page_files WHERE page_id=:id",
        { id: pageId },
      );
      expect(finalInventory.some((file) => file.path === "action-summary.csv")).toBe(true);
      await testInfo.attach("cli-result", {
        body: Buffer.from(await run(["read", pageId])),
        contentType: "text/markdown",
      });
    },
  );
});
