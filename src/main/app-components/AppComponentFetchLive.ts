import * as Layer from "effect/Layer";
import { electronUpdateFetch } from "../electron-update-fetch";
import { AppComponentFetch } from "./AppComponents";

/** Use Chromium's system proxy and keep redirect policy in the component downloader. */
export const live = Layer.succeed(AppComponentFetch, { fetch: electronUpdateFetch });
