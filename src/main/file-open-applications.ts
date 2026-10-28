import { posix } from "node:path";
export { prioritizedBundleIdsForFile } from "../shared/file-open-applications";
import { z } from "zod";
import type { FileOpenApplicationsResult } from "../shared/file-open-applications";

export const MAX_FILE_OPEN_APPLICATIONS = 20;

const application = z.object({
  name: z.string().trim().min(1).max(256),
  appPath: z
    .string()
    .startsWith("/")
    .max(4096)
    .refine((value) => !value.includes("\0") && /\.app\/?$/iu.test(value)),
  bundleId: z.string().optional(),
});

/**
 * LaunchServices can return duplicate versions and the app itself; keep only usable alternatives
 * in its order. A well-known viewer for the type becomes the default when it is installed.
 */
export function parseLaunchServicesApplications(
  output: string,
  ownApplicationPath: string,
  prioritizedBundleIds: readonly string[] = [],
): FileOpenApplicationsResult {
  const empty = { defaultApplication: null, applications: [] };
  const result = z
    .object({ defaultApplication: z.unknown(), applications: z.array(z.unknown()).max(256) })
    .safeParse(
      (() => {
        try {
          return JSON.parse(output) as unknown;
        } catch {
          return null;
        }
      })(),
    );
  if (!result.success) return empty;
  const ownBundle = ownApplicationPath.match(/^(.+?\.app)(?:\/|$)/iu)?.[1];
  const read = (value: unknown) => {
    const parsed = application.safeParse(value);
    if (!parsed.success) return null;
    const appPath = posix.normalize(parsed.data.appPath).replace(/\/$/u, "");
    if (parsed.data.bundleId === "app.jyu.nodex" || (ownBundle && appPath === ownBundle))
      return null;
    return {
      bundleId: parsed.data.bundleId ?? "",
      application: { name: parsed.data.name, appPath, iconDataUrl: null },
    };
  };
  const ordered = new Map<string, NonNullable<ReturnType<typeof read>>>();
  for (const entry of [result.data.defaultApplication, ...result.data.applications]) {
    const value = read(entry);
    if (value && !ordered.has(value.application.appPath))
      ordered.set(value.application.appPath, value);
  }
  const candidates = [...ordered.values()];
  const rank = (bundleId: string) => {
    const index = prioritizedBundleIds.indexOf(bundleId);
    return index < 0 ? prioritizedBundleIds.length : index;
  };
  // A stable sort keeps the system default ahead of the remaining LaunchServices order.
  const [first, ...rest] = candidates.toSorted((a, b) => rank(a.bundleId) - rank(b.bundleId));
  const systemDefault = read(result.data.defaultApplication);
  const promoted =
    first && (systemDefault !== null || rank(first.bundleId) < prioritizedBundleIds.length);
  return {
    defaultApplication: promoted ? first.application : null,
    applications: (promoted ? rest : candidates)
      .slice(0, MAX_FILE_OPEN_APPLICATIONS)
      .map((value) => value.application),
  };
}

// Pass filenames as argv, never as JavaScript source or shell interpolation.
export const FILE_OPEN_APPLICATIONS_JXA = `ObjC.import('AppKit');
function run(argv) {
  var workspace = $.NSWorkspace.sharedWorkspace;
  var url = $.NSURL.fileURLWithPath(argv[0]);
  function describe(value) {
    if (!value || value.isNil()) return null;
    var bundle = $.NSBundle.bundleWithURL(value);
    var name = bundle.objectForInfoDictionaryKey('CFBundleDisplayName');
    if (!name || name.isNil()) name = bundle.objectForInfoDictionaryKey('CFBundleName');
    if (!name || name.isNil()) name = value.lastPathComponent.stringByDeletingPathExtension;
    var id = bundle.bundleIdentifier;
    return { name: ObjC.unwrap(name), appPath: ObjC.unwrap(value.path), bundleId: id && !id.isNil() ? ObjC.unwrap(id) : '' };
  }
  var urls = workspace.URLsForApplicationsToOpenURL(url);
  var applications = [];
  for (var i = 0; i < Math.min(Number(urls.count), 256); i++) applications.push(describe(urls.objectAtIndex(i)));
  return JSON.stringify({ defaultApplication: describe(workspace.URLForApplicationToOpenURL(url)), applications: applications });
}`;
