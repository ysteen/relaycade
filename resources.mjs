import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";

const percent = (used, total) =>
  total > 0
    ? Math.round(Math.max(0, Math.min(100, (used / total) * 100)) * 10) / 10
    : null;
const number = (text) =>
  text?.trim() && Number.isFinite(Number(text)) ? Number(text) : null;

export function networkCounters(text) {
  const interfaces = [];
  let rxBytes = 0,
    txBytes = 0;
  for (const line of text?.split("\n") ?? []) {
    const match = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (!match || match[1].trim() === "lo") continue;
    const fields = match[2].trim().split(/\s+/);
    const rx = number(fields[0]),
      tx = number(fields[8]);
    if (fields.length < 16 || rx === null || tx === null || rx < 0 || tx < 0)
      return null;
    interfaces.push(match[1].trim());
    rxBytes += rx;
    txBytes += tx;
  }
  return interfaces.length
    ? { interfaces: interfaces.sort().join(","), rxBytes, txBytes }
    : null;
}

export class ResourceMonitor {
  constructor({
    read = (path) => readFileSync(path, "utf8"),
    parallelism = availableParallelism,
    processCpu = process.cpuUsage,
    processMemory = () => process.memoryUsage().rss,
    now = () => performance.now(),
    date = () => new Date().toISOString(),
  } = {}) {
    Object.assign(this, {
      read,
      parallelism,
      processCpu,
      processMemory,
      now,
      date,
    });
    this.previous = this.measure();
  }
  file(path) {
    try {
      return this.read(path);
    } catch {
      return null;
    }
  }
  measure() {
    let cores = Math.max(1, this.parallelism());
    const quota = this.file("/sys/fs/cgroup/cpu.max")?.trim().split(/\s+/);
    const legacyQuota = number(
      this.file("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"),
    );
    const legacyPeriod = number(
      this.file("/sys/fs/cgroup/cpu/cpu.cfs_period_us"),
    );
    if (
      quota?.[0] !== "max" &&
      Number(quota?.[0]) > 0 &&
      Number(quota?.[1]) > 0
    )
      cores = Math.min(cores, Number(quota[0]) / Number(quota[1]));
    else if (legacyQuota > 0 && legacyPeriod > 0)
      cores = Math.min(cores, legacyQuota / legacyPeriod);
    const usage = this.file("/sys/fs/cgroup/cpu.stat")?.match(
      /^usage_usec\s+(\d+)$/m,
    );
    const legacyUsage = number(
      this.file("/sys/fs/cgroup/cpuacct/cpuacct.usage"),
    );
    const containerCpu = usage
      ? Number(usage[1])
      : legacyUsage === null
        ? null
        : legacyUsage / 1000;
    const containerMemory =
      number(this.file("/sys/fs/cgroup/memory.current")) ??
      number(this.file("/sys/fs/cgroup/memory/memory.usage_in_bytes"));
    const limit =
      number(this.file("/sys/fs/cgroup/memory.max")) ??
      number(this.file("/sys/fs/cgroup/memory/memory.limit_in_bytes"));
    const isolated =
      this.file("/.dockerenv") !== null ||
      this.file("/run/.containerenv") !== null ||
      /docker|kubepods|libpod|containerd|lxc/.test(
        this.file("/proc/self/cgroup") ?? "",
      );
    const container =
      isolated && containerCpu !== null && containerMemory !== null;
    const processUsage = this.processCpu();
    return {
      at: this.now(),
      sampledAt: this.date(),
      network: isolated ? networkCounters(this.file("/proc/net/dev")) : null,
      service: {
        scope: container ? "container" : "process",
        cores,
        usageMicroseconds: container
          ? containerCpu
          : processUsage.user + processUsage.system,
        usedBytes: container ? containerMemory : this.processMemory(),
        limitBytes:
          container && limit > 0 && Number.isSafeInteger(limit) ? limit : null,
      },
    };
  }
  sample() {
    if (this.cached && this.now() - this.previous.at < 1000) return this.cached;
    const current = this.measure(),
      previous = this.previous;
    const elapsed = current.at - previous.at;
    const serviceUsage =
      current.service.usageMicroseconds - previous.service.usageMicroseconds;
    const { usageMicroseconds: _, ...service } = current.service;
    let network = null;
    if (current.network) {
      const valid =
        elapsed >= 1000 &&
        previous.network &&
        current.network.interfaces === previous.network.interfaces &&
        current.network.rxBytes >= previous.network.rxBytes &&
        current.network.txBytes >= previous.network.txBytes;
      network = {
        scope: "container",
        rxBytes: current.network.rxBytes,
        txBytes: current.network.txBytes,
        rxBytesPerSecond: valid
          ? ((current.network.rxBytes - previous.network.rxBytes) * 1000) /
            elapsed
          : null,
        txBytesPerSecond: valid
          ? ((current.network.txBytes - previous.network.txBytes) * 1000) /
            elapsed
          : null,
      };
    }
    this.cached = {
      sampledAt: current.sampledAt,
      service: {
        ...service,
        cpuPercent:
          elapsed >= 1000 &&
          serviceUsage >= 0 &&
          current.service.scope === previous.service.scope
            ? percent(serviceUsage, elapsed * 1000 * service.cores)
            : null,
        memoryPercent: service.limitBytes
          ? percent(service.usedBytes, service.limitBytes)
          : null,
        network,
      },
    };
    this.previous = current;
    return this.cached;
  }
}
