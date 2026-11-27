import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import type { VisualProgram } from "../../shared/visual/compiler";
import { resolveVisualSources, parseVisualSource } from "./VisualSources";

it.effect("Page Files and tables preserve their own rows and are read through the host", () =>
  Effect.gen(function* () {
    const program: VisualProgram = {
      textLiterals: [],
      datumSpans: [],
      figures: [
        {
          caption: "Example",
          sources: {
            inline: { kind: "data", key: "name", data: [{ name: "one", value: 1 }] },
            file: { kind: "file", key: "name", file: "file-id", format: "csv" },
            table: { kind: "table", key: "name", block: "table-block", header: true },
          },
          params: {},
        },
      ],
    };
    const rows = yield* resolveVisualSources(program, (reference) =>
      reference.kind === "table"
        ? Effect.succeed({
            kind: "table",
            cells: [
              ["name", "value"],
              ["two", "2"],
            ],
          })
        : Effect.succeed({ kind: "file", text: 'name,value\n"three, Inc.",3\n' }),
    );
    expect(rows).toEqual([
      {
        inline: [{ name: "one", value: 1 }],
        file: [{ name: "three, Inc.", value: "3" }],
        table: [{ name: "two", value: "2" }],
      },
    ]);
  }),
);

it.effect("refuses ambiguous columns and requires unique keys after source resolution", () =>
  Effect.gen(function* () {
    const source = { kind: "file", format: "csv", key: "name", file: "file-id" } as const;
    expect(() => parseVisualSource(source, { kind: "file", text: "name,name\na,b" })).toThrow(
      "unique",
    );
    const duplicated = resolveVisualSources(
      {
        figures: [{ caption: "Example", sources: { source }, params: {} }],
        datumSpans: [],
        textLiterals: [],
      },
      () => Effect.succeed({ kind: "file", text: "name,value\nsame,1\nsame,2" }),
    );
    const result = yield* Effect.result(duplicated);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: expect.objectContaining({
        message: expect.stringContaining("Row keys must be unique"),
      }),
    });
  }),
);
