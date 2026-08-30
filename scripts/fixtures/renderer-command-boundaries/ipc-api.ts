export interface IpcApi {
  "projects:list": { args: []; result: readonly unknown[] };
  "projects:update": { args: [projectId: string]; result: unknown };
}
