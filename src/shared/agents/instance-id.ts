/** A fresh Profile instance key, ready for the Agent Runtime's routing schema. */
export const newAgentInstanceId = (driver: string): string =>
  `${driver.slice(0, 27)}_${crypto.randomUUID()}`;
