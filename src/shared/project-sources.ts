import type { components } from "@nodex/core-protocol";

export type ProjectSource = components["schemas"]["ProjectSource"];

/** Repository identities are never local executable paths. */
export const localProjectSourceRoots = (sources: readonly ProjectSource[]): string[] =>
  sources.flatMap((source) => (source.kind === "directory" ? [source.path] : []));

export const projectSourceIdentity = (source: ProjectSource): string =>
  source.kind === "directory" ? source.path : source.remote;

/** Optimistic source metadata keeps the same distinction as the eventual Core projection. */
export const projectSourceFromIdentity = (identity: string, order: number): ProjectSource =>
  canonicalGitRemote(identity) === identity
    ? { kind: "repository", remote: identity, order }
    : { kind: "directory", path: identity, order };

/** Canonical HTTPS identity; clone authentication and local paths belong to the Host. */
export function canonicalGitRemote(value: string): string | null {
  const raw = value.trim();
  if (!raw || raw.length > 2048 || /[\s\\?#]/u.test(raw)) return null;
  const normalized = raw.replace(/^git@([^:]+):/u, "ssh://git@$1/");
  try {
    const url = new URL(normalized);
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol) || url.password) return null;
    const ssh = url.protocol === "ssh:";
    if (url.username && (!ssh || url.username !== "git")) return null;
    if (ssh && url.port && url.port !== "22") return null;
    if (url.port && Number(url.port) === 0) return null;
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
    if (!hostname.split(".").every((label) => /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/u.test(label)))
      return null;
    const path = url.pathname.replace(/\/+$/u, "").replace(/\.git$/u, "");
    if (
      !path.slice(1) ||
      path
        .slice(1)
        .split("/")
        .some((segment) => !segment || segment === "." || segment === "..")
    )
      return null;
    const port = ssh || url.protocol === "git:" || url.port === "443" ? "" : url.port;
    return `https://${hostname}${port ? `:${port}` : ""}${path}`;
  } catch {
    return null;
  }
}
