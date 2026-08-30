export const invokePreloadDirectly = async (): Promise<void> => {
  await window.api!.invoke("terminal-write", "session-1", "pwd\n");
  await window.api?.invoke("terminal-write", "session-1", "ls\n");
};
