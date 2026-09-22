/** Avatar and sentence-name budgets are independent so larger groups stay readable. */
export function getSubagentActivityDisplayBudget(count: number) {
  const namedCount = count > 3 ? 2 : count;
  return {
    avatarCount: Math.min(count, 4),
    namedCount,
    hiddenCount: count - namedCount,
  };
}
