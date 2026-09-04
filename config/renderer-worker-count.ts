/** A stable capacity budget; instantaneous free memory must not change test scheduling. */
export const rendererWorkerCount = ({
  ci,
  stress,
  parallelism,
  memoryBytes,
}: {
  readonly ci: boolean;
  readonly stress: boolean;
  readonly parallelism: number;
  readonly memoryBytes: number;
}): number => {
  if (stress) return 1;
  const roomyDeveloperMachine = parallelism >= 8 && memoryBytes >= 24 * 1024 ** 3;
  return Math.min(parallelism, ci || roomyDeveloperMachine ? 4 : 2);
};
