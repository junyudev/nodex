# Visuals

Use a `visual` code fence for an offline chart, diagram or timeline. Prepare the
raw JSX locally or send it to `visual_check`. Run
`nodex visual check FILE|- --json --out DIR` to see the diagnostics and both
appearances. Add `--block BLOCK` to resolve Files and tables from that Block's
Page. Fix errors, inspect warnings and the screenshots, and check again. Once
the figure is ready, write the fence to the Page in one edit. Use
`nodex visual snapshot --block BLOCK --theme dark --out DIR` for an existing
Visual. Omit the theme to export both appearances.

Choose a form that answers the question. Use a line for a trajectory, bars for
a comparison and a timeline for dated events. Use theme colors, directly label
the relevant values or series, and leave room for labels at the edges. Put what
the figure shows and the data source in the caption. Give the outer SVG a fixed
`width` and `height` of at most 640 by 400; a narrower Page column scales the
whole figure down, so keep text at 12 or larger.

```jsx
<nodex.Visualize
  caption="Completed requests by entry point. Source: sampled launch review."
  sources={{
    requests: {
      kind: "data",
      key: "entry",
      data: [
        { entry: "In-place Ask", count: 11 },
        { entry: "Conversation", count: 18 },
      ],
    },
  }}
  params={{}}
>
  {({ requests, datum, theme }) => (
    <svg role="img" aria-label="Requests by entry point" width={360} height={100}>
      {requests.map((row, i) => (
        <g key={row.entry} transform={`translate(0 ${i * 44})`}>
          <text x={8} y={30} fill={theme.foreground}>
            {row.entry}
          </text>
          <rect
            x={126}
            y={14}
            width={row.count * 10}
            height={24}
            fill={theme["viz-series-1"]}
            {...datum(row, "count")}
          />
          <text x={132 + row.count * 10} y={30} fill={theme.foreground}>
            {row.count}
          </text>
        </g>
      ))}
    </svg>
  )}
</nodex.Visualize>
```

Use one `nodex.Visualize` or a single `div` of Visuals after any imports. Each
Visualize takes a string `caption` and object literals for `sources` and
`params`. Its synchronous function receives the named row arrays, current
`params` values, `theme` CSS values, and `datum(row, field?)`. Pass the
original row to `datum` and spread the result on its mark. Hooks are available
inside the function. Return SVG or a `div` of SVGs.

Every source has a `key` column or array of columns that identify a row. Use
`{kind: "data", key, data}` for inline rows, or
`{kind: "query", key, sql, data, refreshedAt}` for an SQL result with its ISO
timestamp. Populate query results before writing the Visual. Use
`{kind: "file", key, file: "FILE_ID", format: "csv" | "json"}` for a Page File
and `{kind: "table", key, block: "BLOCK_ID", header: true}` for a Page table.
Files and tables need unique column headings, and CSV and table cells are
strings. JSON Files contain an array of objects. Inline sources allow 2,000
rows and 256 KiB each. The Visual source text limit is 1 MiB.

Parameter kinds are `range` with `min`, `max`, optional `step` and `value`,
`select` with scalar `options` and `value`, and `toggle` with boolean `value`.
Use `params` for values that should survive reopening the Page.

Optional imports are `react`, `d3-scale`, `d3-shape`, `d3-array`, `d3-format`,
`d3-time`, `d3-time-format`, `d3-hierarchy` and `@observablehq/plot`. The
guest can only use bundled modules and data supplied by Nodex.
