import { getIntl, type IntlShape } from "@/lib/i18n";
import type { OccurrenceEditScope } from "@/lib/types";

export interface OccurrenceScopeOption {
  scope: OccurrenceEditScope;
  label: string;
  isPrimary?: boolean;
}

export function resolveOccurrenceScopeOptions(
  thisAndFutureEquivalentToAll: boolean,
  intl: IntlShape = getIntl(),
): OccurrenceScopeOption[] {
  if (thisAndFutureEquivalentToAll) {
    return [
      {
        scope: "this",
        label: intl.formatMessage({
          id: "board.occurrenceScopeOptions.onlyThis",
          defaultMessage: "Only this occurrence",
        }),
      },
      {
        scope: "all",
        label: intl.formatMessage({
          id: "board.occurrenceScopeOptions.all",
          defaultMessage: "All occurrences",
        }),
        isPrimary: true,
      },
    ];
  }

  return [
    {
      scope: "this",
      label: intl.formatMessage({
        id: "board.occurrenceScopeOptions.onlyThis",
        defaultMessage: "Only this occurrence",
      }),
    },
    {
      scope: "this-and-future",
      label: intl.formatMessage({
        id: "board.occurrenceScopeOptions.thisAndFuture",
        defaultMessage: "This and future",
      }),
      isPrimary: true,
    },
  ];
}
