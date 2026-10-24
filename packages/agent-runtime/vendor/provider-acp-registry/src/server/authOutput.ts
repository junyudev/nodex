/** Masks injected secrets before terminal output enters a queue or observable state. */
export function makeAuthOutputRedactor(values: ReadonlyArray<string>) {
  const secrets = [...new Set(values.filter((value) => value.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  const longest = secrets[0]?.length ?? 0;
  let pending = "";
  return {
    push(chunk: string): string {
      if (secrets.length === 0) return chunk;
      const text = pending + chunk;
      const safe: string[] = [];
      let offset = 0;
      while (offset < text.length) {
        const remaining = text.length - offset;
        // Keep only an incomplete secret prefix, so ordinary login prompts
        // appear immediately and a secret cannot escape across chunk boundaries.
        if (
          remaining < longest &&
          secrets.some(
            (secret) => secret.length > remaining && secret.startsWith(text.slice(offset)),
          )
        )
          break;
        const match = secrets.find((secret) => text.startsWith(secret, offset));
        if (match) {
          safe.push("[redacted]");
          offset += match.length;
          continue;
        }
        safe.push(text[offset]!);
        offset++;
      }
      pending = text.slice(offset);
      return safe.join("");
    },
    finish(): string {
      const result = pending.length === 0 ? "" : "[redacted]";
      pending = "";
      return result;
    },
  };
}
