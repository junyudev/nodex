/** Desktop external navigation never carries embedded credentials or another scheme. */
export function requireCredentialFreeHttpsUrl(value: string): string {
  if (typeof value !== "string" || value.length > 8_192)
    throw new Error("External URL is too long or invalid");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("External navigation requires a credential-free HTTPS URL");
  return url.toString();
}

/** Page reports may open a credential-free web link after native guest input. */
export function requireCredentialFreeHttpUrl(value: string): string {
  if (typeof value !== "string" || value.length > 8_192)
    throw new Error("External URL is too long or invalid");
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new Error("External navigation requires a credential-free web URL");
  return url.toString();
}
