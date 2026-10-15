import * as Predicate from "effect/Predicate";
import type { AgentRuntimeConfiguration } from "./Interface.ts";

/**
 * First stdin frame of an execution process. Provider instances may carry credentials, so they
 * travel over the private host pipe and never enter the process environment or arguments.
 */
export interface AgentRuntimeBootstrap {
  readonly type: "bootstrap";
  readonly providers: AgentRuntimeConfiguration["providers"];
  readonly hostTools?: NonNullable<AgentRuntimeConfiguration["host"]>["tools"];
}

/** Reads exactly one bootstrap line; later lines remain on the iterator for requests. */
export async function readAgentRuntimeBootstrap(
  lines: AsyncIterator<string>,
): Promise<Pick<AgentRuntimeConfiguration, "providers" | "host">> {
  const first = await lines.next();
  if (first.done) throw new Error("Agent Runtime stdin closed before its bootstrap frame.");
  const frame: unknown = JSON.parse(first.value);
  if (
    !Predicate.isObject(frame) ||
    frame.type !== "bootstrap" ||
    !Predicate.isObject(frame.providers)
  )
    throw new Error("Agent Runtime expected a bootstrap frame first.");
  if (frame.hostTools !== undefined && !Array.isArray(frame.hostTools))
    throw new Error("Agent Runtime bootstrap host tools must be a list.");
  const bootstrap = frame as unknown as AgentRuntimeBootstrap;
  return {
    providers: bootstrap.providers,
    ...(bootstrap.hostTools === undefined ? {} : { host: { tools: bootstrap.hostTools } }),
  };
}
