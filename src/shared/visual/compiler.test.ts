import { describe, expect, test } from "vite-plus/test";
import type { VisualRewrite } from "./contract";
import { compileVisual, rewriteVisual } from "./native";

const source = `import { scaleLinear } from "d3-scale";
<nodex.Visualize
  caption="🍀 Sample and cached query"
  sources={{
    samples: {kind: 'data', key: ['week', 'entry'], data: [
      {week: '1', entry: "Ask", count: -2}, // baseline
      {week: '2', entry: "Ask", count: 4},
    ]},
    prior: {kind: 'query', key: 'name', sql: 'select 2', data: [{name: 'old', count: 2}],
      refreshedAt: '2026-11-18T00:00:00Z'},
  }}
  params={{ threshold: {kind: 'range', min: 0, max: 8, value: 3} }}
>
  {({samples, datum, params, theme}) => {
    const x = scaleLinear().domain([0, 8]).range([0, 300]);
    return <svg role="img" aria-label="Sample" width={320} height={80}>
      <rect x={0} y={40} width={x(params.threshold)} height={20}
        fill={theme.primary} {...datum(samples[0], "count")} />
      <text x={10} y={20}>First &amp; second</text>
      <text x={5} y={80}>{"🍀 Label"}</text>
    </svg>;
  }}
</nodex.Visualize>`;

function compile(input = source) {
  const result = compileVisual(input);
  expect(result.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
  if (!result.ok) throw new Error("Expected a valid Visual");
  return result;
}

function rewrite(change: VisualRewrite, before: string, after: string) {
  const result = rewriteVisual(source, change);
  expect(result).toEqual({ ok: true, source: source.replace(before, after) });
  if (!result.ok) throw new Error("Expected a valid rewrite");
  return compile(result.source).program;
}

describe("Visual source contract", () => {
  test("extracts sources, captions, params and UTF-16 spans through Unicode", () => {
    const { program } = compile();
    const figure = program.figures[0];
    expect(figure.caption).toBe("🍀 Sample and cached query");
    expect(figure.sources.samples.key).toEqual(["week", "entry"]);
    expect(figure.params.threshold.value).toBe(3);
    expect(
      program.textLiterals.map(({ start, end, value }) => [source.slice(start, end), value]),
    ).toEqual([
      ["First &amp; second", "First & second"],
      ['"🍀 Label"', "🍀 Label"],
    ]);
    expect(program.datumSpans).toHaveLength(1);
  });

  test("reports invalid root, network access, imports and duplicate row keys", () => {
    expect(compileVisual("<svg />").diagnostics[0].code).toBe("root");
    expect(
      compileVisual(source.replace("d3-scale", "https://example.invalid/lib")).diagnostics.map(
        ({ code }) => code,
      ),
    ).toContain("import");
    expect(
      compileVisual(
        source.replace("const x =", 'fetch("https://example.invalid"); const x ='),
      ).diagnostics.map(({ code }) => code),
    ).toContain("offline");
    expect(
      compileVisual(source.replace("week: '2'", "week: '1'")).diagnostics.map(({ code }) => code),
    ).toContain("source");
  });

  test("rewrites specifically the selected row field, preserving comments and sibling rows", () => {
    const program = rewrite(
      { kind: "row", figure: 0, source: "samples", key: ["1", "Ask"], field: "count", value: 5 },
      "count: -2",
      "count: 5",
    );
    expect(program.figures[0].sources.samples).toMatchObject({
      data: [{ count: 5 }, { count: 4 }],
    });
  });

  test("refreshes the result and its timestamp and retains the SQL", () => {
    const result = rewriteVisual(source, {
      kind: "query",
      figure: 0,
      source: "prior",
      data: [{ name: "new", count: 7 }],
      refreshedAt: "2026-11-19T00:00:00Z",
    });
    expect(result).toEqual({
      ok: true,
      source: source
        .replace("[{name: 'old', count: 2}]", '[{"name":"new","count":7}]')
        .replace("'2026-11-18T00:00:00Z'", '"2026-11-19T00:00:00Z"'),
    });
  });

  test("rewrites either form of JSX string and escapes JavaScript and JSX syntax", () => {
    const [raw, quoted] = compile().program.textLiterals;
    rewrite({ kind: "text", span: raw, value: "< & {}" }, "First &amp; second", '{"< & {}"}');
    rewrite(
      { kind: "text", span: quoted, value: 'Quoted "name"' },
      '"🍀 Label"',
      '"Quoted \\"name\\""',
    );
  });

  test("rewrites a param value and rejects an out-of-range edit", () => {
    rewrite({ kind: "param", figure: 0, param: "threshold", value: 7 }, "value: 3", "value: 7");
    expect(
      rewriteVisual(source, { kind: "param", figure: 0, param: "threshold", value: 9 }).ok,
    ).toBe(false);
  });
});
