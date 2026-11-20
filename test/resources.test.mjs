import assert from "node:assert/strict";
import test from "node:test";
import { ResourceMonitor, networkCounters } from "../resources.mjs";
const nic = (name, rx, tx) =>
  `${name}: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0`;
function fixture(files = {}) {
  let at = 0,
    usage = 0;
  const monitor = new ResourceMonitor({
    read(path) {
      if (!(path in files)) throw new Error("Not present");
      return files[path];
    },
    parallelism: () => 4,
    processCpu: () => ({ user: usage, system: 0 }),
    processMemory: () => 128,
    now: () => at,
    date: () => "2026-11-08T00:00:00Z",
  });
  return {
    monitor,
    files,
    advance() {
      at += 1000;
      usage += 500000;
    },
  };
}

test("container usage includes helper processes and respects fractional CPU and memory limits", () => {
  const f = fixture({
    "/.dockerenv": "",
    "/sys/fs/cgroup/cpu.max": "50000 100000",
    "/sys/fs/cgroup/cpu.stat": "usage_usec 0\n",
    "/sys/fs/cgroup/memory.current": "131072",
    "/sys/fs/cgroup/memory.max": "524288",
  });
  assert.equal(f.monitor.sample().service.cpuPercent, null);
  f.advance();
  f.files["/sys/fs/cgroup/cpu.stat"] = "usage_usec 250000\n";
  const value = f.monitor.sample();
  assert.equal(Object.hasOwn(value, "host"), false);
  assert.equal(value.service.scope, "container");
  assert.equal(value.service.cores, 0.5);
  assert.equal(value.service.cpuPercent, 50);
  assert.equal(value.service.memoryPercent, 25);
  assert.equal(
    f.monitor.sample(),
    value,
    "Concurrent viewers share a stable sample",
  );
});

test("unsupported platforms expose process usage without reporting host network traffic", () => {
  const f = fixture({ "/proc/net/dev": nic("eth0", 99999, 99999) });
  f.advance();
  const value = f.monitor.sample();
  assert.equal(value.service.scope, "process");
  assert.equal(value.service.cpuPercent, 12.5);
  assert.equal(value.service.usedBytes, 128);
  assert.equal(value.service.limitBytes, null);
  assert.equal(value.service.memoryPercent, null);
  assert.equal(value.service.network, null);
});

test("legacy cgroups do not report the unlimited sentinel as a memory limit", () => {
  const f = fixture({
    "/.dockerenv": "",
    "/sys/fs/cgroup/cpuacct/cpuacct.usage": "0",
    "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "200000",
    "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000",
    "/sys/fs/cgroup/memory/memory.usage_in_bytes": "262144",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712",
  });
  f.advance();
  f.files["/sys/fs/cgroup/cpuacct/cpuacct.usage"] = "1000000000";
  const value = f.monitor.sample();
  assert.equal(value.service.scope, "container");
  assert.equal(value.service.cpuPercent, 50);
  assert.equal(value.service.limitBytes, null);
});

test("a bare host cgroup is never labelled as bridge container usage", () => {
  const f = fixture({
    "/sys/fs/cgroup/cpu.stat": "usage_usec 99999999",
    "/sys/fs/cgroup/memory.current": "999999",
  });
  f.advance();
  assert.equal(f.monitor.sample().service.scope, "process");
});

test("a configured memory limit remains visible", () => {
  const f = fixture({
    "/.dockerenv": "",
    "/sys/fs/cgroup/cpu.stat": "usage_usec 0",
    "/sys/fs/cgroup/memory.current": "131072",
    "/sys/fs/cgroup/memory.max": "2097152",
  });
  f.advance();
  const value = f.monitor.sample();
  assert.equal(value.service.limitBytes, 2097152);
  assert.equal(value.service.memoryPercent, 6.3);
});

test("network counters aggregate interfaces while excluding loopback and corrupt data", () => {
  assert.deepEqual(
    networkCounters(
      [
        nic("lo", 99999, 99999),
        nic("eth0", 100, 200),
        nic("eth1", 300, 400),
      ].join("\n"),
    ),
    { interfaces: "eth0,eth1", rxBytes: 400, txBytes: 600 },
  );
  assert.equal(networkCounters(null), null);
  assert.equal(networkCounters(nic("lo", 5, 5)), null);
  assert.equal(networkCounters("eth0: invalid"), null);
  assert.equal(networkCounters(nic("eth0", -1, 5)), null);
});

test("network rates follow actual elapsed time and reset safely across interface changes", () => {
  const f = fixture({
    "/.dockerenv": "",
    "/proc/net/dev": nic("eth0", 1000, 2000),
  });
  assert.equal(f.monitor.sample().service.network.rxBytesPerSecond, null);
  f.advance();
  f.files["/proc/net/dev"] = nic("eth0", 3048, 6096);
  const n = f.monitor.sample().service.network;
  assert.equal(n.rxBytes, 3048);
  assert.equal(n.txBytes, 6096);
  assert.equal(n.rxBytesPerSecond, 2048);
  assert.equal(n.txBytesPerSecond, 4096);
  f.advance();
  f.files["/proc/net/dev"] = nic("eth0", 1, 2);
  assert.equal(f.monitor.sample().service.network.rxBytesPerSecond, null);
  f.advance();
  f.files["/proc/net/dev"] = nic("eth1", 100, 200);
  assert.equal(f.monitor.sample().service.network.txBytesPerSecond, null);
});
