import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const mergeClasses = extendTailwindMerge<"icon-size">({
  extend: {
    classGroups: {
      "icon-size": [
        "icon-3xs",
        "icon-xxs",
        "icon-2xs",
        "icon-xs",
        "icon-sm",
        "icon-base",
        "icon-md",
        "icon-lg",
      ],
    },
    conflictingClassGroups: {
      "icon-size": ["size", "w", "h"],
      size: ["icon-size"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return mergeClasses(clsx(inputs));
}

/**
 * The record without `key`, or the same record when it has no such key, so state updaters keep
 * their identity when nothing changes. A plain helper keeps the computed-key destructuring out of
 * compiled components and hooks.
 */
export function omitRecordKey<Value>(
  record: Readonly<Record<string, Value>>,
  key: string,
): Readonly<Record<string, Value>> {
  if (!Object.hasOwn(record, key)) return record;
  const { [key]: _omitted, ...rest } = record;
  return rest;
}
