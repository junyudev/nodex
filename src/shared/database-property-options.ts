import type { DatabasePropertyOption } from "./database-kernel";
import type { DataSourcePropertyRecordV2 } from "./database-module-v2";

export const readDatabasePropertyOptions = (
  property: DataSourcePropertyRecordV2,
): readonly DatabasePropertyOption[] => {
  if (property.valueType !== "select" && property.valueType !== "multi_select") {
    return [];
  }
  const options = property.config.options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option) => {
    if (typeof option !== "object" || option === null || Array.isArray(option)) {
      return [];
    }
    const id = option.id;
    const name = option.name;
    const color = option.color;
    if (typeof id !== "string" || typeof name !== "string") return [];
    if (color !== undefined && typeof color !== "string") return [];
    return [{ id, name, ...(color === undefined ? {} : { color }) }];
  });
};
