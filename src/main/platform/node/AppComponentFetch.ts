import * as Layer from "effect/Layer";
import { AppComponentFetch } from "../../app-components/AppComponents";

/** Serve enables Node's proxy environment at launch. The downloader checks each redirect. */
export const live = Layer.succeed(AppComponentFetch, {
  fetch: (url, init) =>
    fetch(url, { ...init, redirect: "manual", credentials: "omit", cache: "no-store" }),
});
