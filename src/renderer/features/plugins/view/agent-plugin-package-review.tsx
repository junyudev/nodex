import type {
  AgentPluginFailure,
  PluginMcpReview,
  PluginPackageReview,
} from "../../../../shared/agent-plugins/ipc";
import type { AgentPluginRejectionReason } from "../../../../shared/agent-plugins/types";

const LAYOUTS = {
  "portable-1.0.0": "Agent Plugins 1.0.0",
  codex: "Codex compatibility",
  claude: "Claude-style",
} as const;

const noteClass = "text-token-text-secondary text-sm";
const headingClass = "font-medium text-token-foreground";

export function PluginRejectionReasons({
  reasons,
}: {
  readonly reasons: readonly AgentPluginRejectionReason[];
}) {
  return (
    <ul className="space-y-1 text-sm">
      {reasons.map((reason, index) => (
        <li key={index} className="wrap-anywhere">
          {reason.message}
          {reason.path ? <span className={noteClass}> · {reason.path}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function AgentPluginError({ error }: { readonly error: AgentPluginFailure }) {
  return (
    <div role="alert" className="space-y-1 text-sm text-danger">
      <p>{error.message}</p>
      {error.reasons ? <PluginRejectionReasons reasons={error.reasons} /> : null}
    </div>
  );
}

function McpServerReview({ server }: { readonly server: PluginMcpReview }) {
  const { transport } = server;
  return (
    <li className="space-y-0.5 wrap-anywhere">
      <div className={headingClass}>{server.key}</div>
      {transport.type === "stdio" ? (
        <>
          <code className="font-mono">
            {[transport.command, ...transport.args].map((arg) => JSON.stringify(arg)).join(" ")}
          </code>
          <div className={noteClass}>Working directory · {transport.cwd}</div>
        </>
      ) : (
        <div>
          {transport.type === "sse" ? "SSE" : "Streamable HTTP"} ·{" "}
          <code className="font-mono">{transport.url}</code>
        </div>
      )}
      {server.configuration.length > 0 ? (
        <div className={noteClass}>Configuration · {server.configuration.join(", ")}</div>
      ) : null}
    </li>
  );
}

export function AgentPluginPackageReview({ pkg }: { readonly pkg: PluginPackageReview }) {
  const { identity } = pkg;
  const author = identity.author?.name ?? identity.author?.email ?? identity.author?.url;
  return (
    <div className="space-y-3 text-sm">
      <div className="space-y-1 wrap-anywhere">
        <p>
          {[identity.name, identity.version, author, LAYOUTS[pkg.layout]]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {identity.description ? <p className={noteClass}>{identity.description}</p> : null}
      </div>
      {pkg.skills.length > 0 ? (
        <section className="space-y-1">
          <h4 className={headingClass}>Skills</h4>
          <ul className="space-y-1">
            {pkg.skills.map((skill) => (
              <li key={skill.directory} className="wrap-anywhere">
                {skill.name}
                {skill.valid ? "" : " (invalid)"}
                {skill.description ? (
                  <span className={noteClass}> · {skill.description}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {pkg.mcpServers.length > 0 ? (
        <section className="space-y-1">
          <h4 className={headingClass}>MCP servers</h4>
          <ul className="space-y-2">
            {pkg.mcpServers.map((server) => (
              <McpServerReview key={server.key} server={server} />
            ))}
          </ul>
        </section>
      ) : null}
      {pkg.hooks.length > 0 ? (
        <section className="space-y-1">
          <h4 className={headingClass}>Hooks · Not executed</h4>
          <ul className="space-y-1">
            {pkg.hooks.flatMap((hook) =>
              hook.events.map((event, index) => (
                <li key={`${hook.source.path}:${index}`} className="wrap-anywhere">
                  <span>{event.name}</span>
                  {event.commands.map((command, index) => (
                    <code key={index} className="block font-mono">
                      {command}
                    </code>
                  ))}
                </li>
              )),
            )}
          </ul>
        </section>
      ) : null}
      {pkg.apps.length > 0 ? (
        <section className="space-y-1">
          <h4 className={headingClass}>App mappings · Require OpenAI-hosted services</h4>
          <ul className="space-y-1">
            {pkg.apps.map((app) => (
              <li key={app.key} className="wrap-anywhere">
                {app.key} · {app.id}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {pkg.diagnostics.length > 0 ? (
        <section className="space-y-1">
          <h4 className={headingClass}>Package warnings</h4>
          <ul className="space-y-1">
            {pkg.diagnostics.map((diagnostic, index) => (
              <li key={index} className="wrap-anywhere">
                {diagnostic.message} <span className={noteClass}>· {diagnostic.path}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
