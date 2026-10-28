import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";
import { readLinuxBrowserResources } from "./linux-browser-resources";

test("the native sampler CLI reports its failure cause while exiting unsuccessfully", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./linux-browser-resources.ts", import.meta.url))],
    { encoding: "utf8" },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr.split("\n")).toContain("Resource output is required.");
});

test("counts only owned Chromium backing objects once while retaining per-process pressure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nodex browser resources "));
  try {
    const procRoot = path.join(root, "proc");
    const cgroupRoot = path.join(root, "cgroup");
    const backing = path.join(root, "memfd:shared-memory-region");
    await writeFile(backing, "");
    await truncate(backing, 2 * 1024 ** 2);
    for (const pid of [200, 300, 999]) {
      const proc = path.join(procRoot, String(pid));
      await mkdir(path.join(proc, "fd"), { recursive: true });
      await writeFile(path.join(proc, "cmdline"), "/cache/ms-playwright/chrome\0--type=renderer\0");
      await writeFile(path.join(proc, "environ"), "TMPDIR=/tmp\0SECRET=must-not-record\0");
      await writeFile(path.join(proc, "status"), "VmRSS:\t101 kB\nVmHWM:\t120 kB\n");
      await writeFile(path.join(proc, "smaps_rollup"), "Pss: 50 kB\nPss_Shmem: 20 kB\n");
      await writeFile(
        path.join(proc, "maps"),
        "1000-2000 r--p 00000000 00:00 0\n2000-3000 rw-p 00000000 00:00 0\n",
      );
      await writeFile(
        path.join(proc, "limits"),
        "Max open files            1024                 4096                 files\n",
      );
      await symlink(backing, path.join(proc, "fd/10"));
    }
    // A Chromium descendant can expose a process title rather than its launch path.
    await writeFile(path.join(procRoot, "300/cmdline"), "/proc/self/exe\0--type=renderer\0");
    await writeFile(path.join(procRoot, "300/comm"), "chrome-headless-\n");
    await mkdir(path.join(procRoot, "self"));
    await writeFile(path.join(procRoot, "self/cgroup"), "0::/job\n");
    await mkdir(path.join(procRoot, "sys/vm"), { recursive: true });
    await writeFile(path.join(procRoot, "sys/vm/max_map_count"), "65530\n");
    await mkdir(path.join(cgroupRoot, "job"), { recursive: true });
    await writeFile(path.join(cgroupRoot, "job/memory.current"), "2000000\n");
    await writeFile(path.join(cgroupRoot, "job/memory.peak"), "3000000\n");
    await writeFile(
      path.join(cgroupRoot, "job/memory.stat"),
      "anon 1200000\nfile 800000\nshmem 700000\n",
    );
    await writeFile(path.join(cgroupRoot, "job/memory.events"), "oom 1\noom_kill 1\n");
    await mkdir(path.join(procRoot, "500"));
    await writeFile(path.join(procRoot, "500/cmdline"), "/usr/bin/node\0");
    const sample = readLinuxBrowserResources([200, 300, 400, 500], { procRoot, cgroupRoot });
    expect(sample.processes.map((process) => process.pid)).toEqual([200, 300]);
    expect(sample.backing.memfd).toMatchObject({
      objects: 1,
      logicalBytes: 2 * 1024 ** 2,
      objects2MiB: 1,
    });
    expect(sample.processes[0]).toMatchObject({
      fdCount: 1,
      sharedMemoryFdCount: 1,
      rssBytes: 101 * 1024,
      highWaterRssBytes: 120 * 1024,
      pssBytes: 50 * 1024,
      pssShmemBytes: 20 * 1024,
      mappedRegionCount: 2,
      tempEnvironment: { TMPDIR: "/tmp" },
    });
    expect(sample.maxMappedRegions).toBe(65530);
    expect(sample.cgroup).toMatchObject({
      currentBytes: 2000000,
      peakBytes: 3000000,
      memory: { shmem: 700000 },
      events: { oom: 1, oom_kill: 1 },
    });
    expect(JSON.stringify(sample)).not.toContain("must-not-record");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses the exposed cgroup root and keeps unavailable counters unknown", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nodex cgroup resources "));
  try {
    const procRoot = path.join(root, "proc");
    const cgroupRoot = path.join(root, "cgroup");
    await mkdir(path.join(procRoot, "self"), { recursive: true });
    await mkdir(cgroupRoot);
    await writeFile(path.join(procRoot, "self/cgroup"), "0::/host/job\n");
    await writeFile(path.join(cgroupRoot, "memory.current"), "1234\n");
    await writeFile(path.join(cgroupRoot, "memory.max"), "max\n");
    const sample = readLinuxBrowserResources([999], { procRoot, cgroupRoot });
    expect(sample.processes).toEqual([]);
    expect(sample.maxMappedRegions).toBeNull();
    expect(sample.cgroup).toMatchObject({
      currentBytes: 1234,
      peakBytes: null,
      maxBytes: null,
      memory: { anon: null, file: null, shmem: null },
      events: { oom: null, oom_kill: null },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps an unavailable owned Chromium FD table unknown", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nodex exited browser resources "));
  try {
    const procRoot = path.join(root, "proc");
    await mkdir(path.join(procRoot, "200"), { recursive: true });
    await writeFile(path.join(procRoot, "200/cmdline"), "/cache/ms-playwright/chrome\0");
    const sample = readLinuxBrowserResources([200], {
      procRoot,
      cgroupRoot: path.join(root, "cgroup"),
    });
    expect(sample.incomplete).toBe(true);
    expect(sample.processes).toMatchObject([
      { pid: 200, fdCount: null, sharedMemoryFdCount: null, mappedRegionCount: null },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
