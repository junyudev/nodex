import { changelogFeed } from "../changelog";
import { getChangelogReleases } from "../lib/changelog-data";

export const prerender = true;

export const GET = async () => Response.json(changelogFeed(await getChangelogReleases()));
