import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...values: ClassValue[]): string => twMerge(clsx(values));
