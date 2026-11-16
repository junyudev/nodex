import { getIntl } from "@/lib/i18n";
export const formatBytes = (bytes: number): string => {
  if (bytes < 1_024)
    return getIntl().formatMessage(
      { id: "lib.fileMetadataFormat.byte", defaultMessage: "{value} B" },
      { value: getIntl().formatNumber(bytes, { useGrouping: false, maximumFractionDigits: 20 }) },
    );
  if (bytes < 1_048_576)
    return getIntl().formatMessage(
      { id: "lib.fileMetadataFormat.kilobyte", defaultMessage: "{value} KB" },
      {
        value: getIntl().formatNumber(bytes / 1_024, {
          useGrouping: false,
          minimumFractionDigits: bytes < 10_240 ? 1 : 0,
          maximumFractionDigits: bytes < 10_240 ? 1 : 0,
        }),
      },
    );
  return getIntl().formatMessage(
    { id: "lib.fileMetadataFormat.megabyte", defaultMessage: "{value} MB" },
    {
      value: getIntl().formatNumber(bytes / 1_048_576, {
        useGrouping: false,
        minimumFractionDigits: bytes < 10_485_760 ? 1 : 0,
        maximumFractionDigits: bytes < 10_485_760 ? 1 : 0,
      }),
    },
  );
};

export const formatDate = (value: string): string =>
  getIntl().formatDate(new Date(value), { dateStyle: "medium", timeStyle: "short" });
