import { resolve } from "node:path";
import { buildSync } from "esbuild";
import type { Plugin } from "vite";

export const TYPOGRAPHY_BOOTSTRAP_ANCHOR = "<!-- nodex-typography:bootstrap -->";

/** The parser and React use one decoder and token scale without loading the renderer graph. */
export function createTypographyBootstrapScript(): string {
  const result = buildSync({
    entryPoints: [resolve("src/renderer/bootstrap/typography-bootstrap.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: true,
    write: false,
  });
  const script = result.outputFiles?.[0]?.text;
  if (script === undefined) throw new Error("Typography bootstrap compilation produced no script");
  return script;
}

export function createTypographyBootstrapHtmlPlugin(): Plugin {
  return {
    name: "nodex:typography-bootstrap",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== "/typography-bootstrap.js") return next();
        response.setHeader("Content-Type", "text/javascript");
        response.end(createTypographyBootstrapScript());
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "typography-bootstrap.js",
        source: createTypographyBootstrapScript(),
      });
    },
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        if (!html.includes(TYPOGRAPHY_BOOTSTRAP_ANCHOR)) {
          return html;
        }
        return html.replace(
          TYPOGRAPHY_BOOTSTRAP_ANCHOR,
          '<script vite-ignore src="./typography-bootstrap.js"></script>',
        );
      },
    },
  };
}
