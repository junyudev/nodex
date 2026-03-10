import type { FormEvent } from "react";

export function handleFormSubmit(
  event: FormEvent<HTMLFormElement>,
  submit: () => void | Promise<void>,
): void {
  event.preventDefault();
  event.stopPropagation();
  void submit();
}

export function resolveFormErrorMessage(error: unknown): string | null {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  return null;
}
