import type { PluginMutationResult } from "../plugin-management";

type Succeeded<T> = Extract<PluginMutationResult<T>, { readonly value: T }>;

/** True when the change was applied, with or without a refresh warning. */
export function pluginMutationSucceeded<T>(
  result: PluginMutationResult<T>,
): result is Succeeded<T> {
  return result.status === "success" || result.status === "success-with-refresh-warning";
}
