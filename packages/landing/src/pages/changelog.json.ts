import changelog from "../../../../CHANGELOG.md?raw";
import { changelogFeed } from "../changelog";

export const prerender = true;

export const GET = () => Response.json(changelogFeed(changelog));
