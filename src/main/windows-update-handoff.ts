/** electron-builder 26.18: --force-run overrides runAfterFinish=false, including /S. */
export const windowsUpdateInstallerCommand = (installer: string, relaunch: boolean) => ({
  executable: installer,
  args: ["/S", "--updated", ...(relaunch ? ["--force-run"] : [])],
  options: { detached: true, stdio: "ignore", windowsHide: true, shell: false } as const,
});
