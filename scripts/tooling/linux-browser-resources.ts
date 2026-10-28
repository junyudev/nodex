import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statfsSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const read = (file: string): string => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};
const entries = (directory: string): string[] | null => {
  try {
    return readdirSync(directory);
  } catch {
    return null;
  }
};
const fields = (text: string): Record<string, number> =>
  Object.fromEntries(
    text.split("\n").flatMap((line) => {
      const match = /^(\w+):?\s+(\d+)(\s+kB)?/u.exec(line);
      return match ? [[match[1], Number(match[2]) * (match[3] ? 1024 : 1)]] : [];
    }),
  );
const filesystem = (directory: string) => {
  try {
    const info = statfsSync(directory);
    return { availableBytes: info.bavail * info.bsize, freeInodes: info.ffree };
  } catch {
    return null;
  }
};

/** Read only the command's owned Chromium PIDs. Missing /proc entries are ordinary exit races. */
export function readLinuxBrowserResources(
  pids: readonly number[],
  { procRoot = "/proc", cgroupRoot = "/sys/fs/cgroup" } = {},
) {
  const deadline = performance.now() + 500;
  const objects = new Map<
    string,
    { kind: "memfd" | "named"; logicalBytes: number; allocatedBytes: number }
  >();
  const processes = [];
  let incomplete = false;
  for (const pid of pids) {
    if (performance.now() >= deadline) {
      incomplete = true;
      break;
    }
    const proc = path.join(procRoot, String(pid));
    const args = read(path.join(proc, "cmdline")).split("\0");
    const name = path.basename(args[0] ?? "");
    const comm = read(path.join(proc, "comm")).trim();
    if (!/chrom(?:e|ium)/u.test(name) && !/chrom(?:e|ium)/u.test(comm)) continue;
    const status = fields(read(path.join(proc, "status")));
    const rollup = fields(read(path.join(proc, "smaps_rollup")));
    const mappings = read(path.join(proc, "maps")).trimEnd();
    const descriptors = entries(path.join(proc, "fd"));
    if (descriptors === null) incomplete = true;
    let sharedMemoryFdCount = 0;
    let examinedFdCount = 0;
    for (const descriptor of descriptors ?? []) {
      if (performance.now() >= deadline || examinedFdCount >= 16384) {
        incomplete = true;
        break;
      }
      examinedFdCount += 1;
      const file = path.join(proc, "fd", descriptor);
      try {
        const target = readlinkSync(file);
        const kind = target.includes("memfd:")
          ? "memfd"
          : target.includes(".org.chromium.") || target.startsWith("/dev/shm/")
            ? "named"
            : null;
        if (kind === null) continue;
        const info = statSync(file, { bigint: true });
        sharedMemoryFdCount += 1;
        objects.set(`${info.dev}:${info.ino}`, {
          kind,
          logicalBytes: Number(info.size),
          allocatedBytes: Number(info.blocks) * 512,
        });
      } catch {
        /* The process can close a descriptor between readdir and stat. */
      }
    }
    const tempEnvironment = Object.fromEntries(
      read(path.join(proc, "environ"))
        .split("\0")
        .flatMap((item) => {
          const separator = item.indexOf("=");
          const key = item.slice(0, separator);
          return ["TMPDIR", "TMP", "TEMP"].includes(key) ? [[key, item.slice(separator + 1)]] : [];
        }),
    );
    processes.push({
      pid,
      type: args.find((argument) => argument.startsWith("--type="))?.slice(7) ?? "browser",
      rssBytes: status.VmRSS ?? null,
      highWaterRssBytes: status.VmHWM ?? null,
      pssBytes: rollup.Pss ?? null,
      pssShmemBytes: rollup.Pss_Shmem ?? null,
      mappedRegionCount: mappings ? mappings.split("\n").length : null,
      fdCount: descriptors?.length ?? null,
      examinedFdCount,
      sharedMemoryFdCount: descriptors === null ? null : sharedMemoryFdCount,
      openFileLimit:
        read(path.join(proc, "limits"))
          .split("\n")
          .find((line) => line.startsWith("Max open files")) ?? null,
      tempEnvironment,
      tmpFilesystem: filesystem(path.join(proc, "root/tmp")),
    });
  }
  const usage = (kind: "memfd" | "named") => {
    const group = [...objects.values()].filter((object) => object.kind === kind);
    return {
      objects: group.length,
      objects2MiB: group.filter((object) => object.logicalBytes === 2 * 1024 ** 2).length,
      logicalBytes: group.reduce((sum, object) => sum + object.logicalBytes, 0),
      allocatedBytes: group.reduce((sum, object) => sum + object.allocatedBytes, 0),
    };
  };
  const relativeCgroup =
    read(path.join(procRoot, "self/cgroup"))
      .split("\n")
      .find((line) => line.startsWith("0::"))
      ?.slice(3) ?? "/";
  const nested = path.join(cgroupRoot, relativeCgroup);
  const cgroup = existsSync(path.join(nested, "memory.current")) ? nested : cgroupRoot;
  const number = (file: string) => {
    const text = read(path.join(cgroup, file)).trim();
    return /^\d+$/u.test(text) ? Number(text) : null;
  };
  const memory = fields(read(path.join(cgroup, "memory.stat")));
  const events = fields(read(path.join(cgroup, "memory.events")));
  const mappingLimit = read(path.join(procRoot, "sys/vm/max_map_count")).trim();
  return {
    at: new Date().toISOString(),
    incomplete,
    processes,
    maxMappedRegions: /^\d+$/u.test(mappingLimit) ? Number(mappingLimit) : null,
    // Objects are deduplicated across processes; their logical size is not physical memory usage.
    backing: { memfd: usage("memfd"), named: usage("named") },
    filesystems: { tmp: filesystem("/tmp"), devShm: filesystem("/dev/shm") },
    cgroup: {
      currentBytes: number("memory.current"),
      peakBytes: number("memory.peak"),
      maxBytes: number("memory.max"),
      memory: { anon: memory.anon ?? null, file: memory.file ?? null, shmem: memory.shmem ?? null },
      events: {
        oom: events.oom ?? null,
        oom_kill: events.oom_kill ?? null,
        high: events.high ?? null,
        max: events.max ?? null,
      },
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [output, ...args] = process.argv.slice(2);
    const pids = args.map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
    if (!output) throw new Error("Resource output is required.");
    const sample = readLinuxBrowserResources(pids);
    mkdirSync(path.dirname(output), { recursive: true });
    appendFileSync(output, JSON.stringify(sample) + "\n");
  } catch (error) {
    // Advisory diagnostics must not change the application suite's exit or cancellation.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
