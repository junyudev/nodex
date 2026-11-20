<nodex.Visualize
  caption="Weekly Pages using an Agent by entry point. Source: launch review sample."
  sources={{
    adoption: {
      kind: "data",
      key: "week",
      data: [
        { week: "Week 1", "In-place Ask": 0, "Ask for change": 58, "Prompt block": 30 },
        { week: "Week 2", "In-place Ask": 0, "Ask for change": 59, "Prompt block": 32 },
        { week: "Week 3", "In-place Ask": 0, "Ask for change": 62, "Prompt block": 33 },
        { week: "Week 4", "In-place Ask": 0, "Ask for change": 55, "Prompt block": 33 },
        { week: "Week 5", "In-place Ask": 34, "Ask for change": 73, "Prompt block": 46 },
        { week: "Week 6", "In-place Ask": 52, "Ask for change": 78, "Prompt block": 48 },
        { week: "Week 7", "In-place Ask": 60, "Ask for change": 87, "Prompt block": 49 },
        { week: "Week 8", "In-place Ask": 69, "Ask for change": 94, "Prompt block": 49 },
      ],
    },
  }}
  params={{}}
>
  {({ adoption, datum, theme }) => {
    const series = ["In-place Ask", "Ask for change", "Prompt block"];
    const colors = [theme["viz-series-1"], theme["viz-series-2"], theme["viz-series-3"]];
    const baseline = 246;
    const scale = 0.9;
    const xFor = (index) => 48 + index * 58;
    return (
      <svg role="img" aria-label="Weekly Pages using an Agent" width={520} height={300}>
        {[0, 50, 100, 150, 200].map((tick) => {
          const y = baseline - tick * scale;
          return (
            <g key={tick}>
              <line x1={39} x2={44} y1={y} y2={y} stroke={theme.border} />
              <text x={36} y={y + 4} textAnchor="end" fill={theme.foreground} fontSize={11}>
                {tick}
              </text>
            </g>
          );
        })}
        <line x1={xFor(4) - 11} x2={xFor(4) - 11} y1={32} y2={baseline}
          stroke={theme.foreground} strokeDasharray="4 4" />
        <text x={xFor(4) - 16} y={24} textAnchor="end" fill={theme.foreground} fontSize={11}>
          In-place Ask launch
        </text>
        {adoption.map((row, week) => {
          let total = 0;
          const x = xFor(week);
          return (
            <g key={row.week}>
              {series.map((name, index) => {
                const value = row[name];
                if (value === 0) return null;
                total += value;
                return (
                  <rect key={name} x={x} y={baseline - total * scale} width={36}
                    height={value * scale} fill={colors[index]} {...datum(row, name)} />
                );
              })}
              <text x={x + 18} y={baseline - total * scale - 6} textAnchor="middle"
                fill={theme.foreground} fontSize={11}>{total}</text>
              <text x={x + 18} y={262} textAnchor="middle" fill={theme.foreground} fontSize={10}>
                {row.week}
              </text>
            </g>
          );
        })}
        {series.map((name, index) => (
          <g key={name} transform={"translate(" + (48 + index * 155) + " 280)"}>
            <rect width={9} height={9} rx={2} fill={colors[index]} />
            <text x={14} y={9} fill={theme.foreground} fontSize={11}>{name}</text>
          </g>
        ))}
      </svg>
    );
  }}
</nodex.Visualize>
