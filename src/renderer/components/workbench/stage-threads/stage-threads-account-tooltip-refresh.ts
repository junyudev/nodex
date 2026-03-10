export function shouldRefreshAccountOnConnectionTooltipOpen({
  isOpen,
  hasAccount,
  refreshInFlight,
}: {
  isOpen: boolean;
  hasAccount: boolean;
  refreshInFlight: boolean;
}): boolean {
  if (!isOpen) return false;
  if (!hasAccount) return false;
  if (refreshInFlight) return false;
  return true;
}
