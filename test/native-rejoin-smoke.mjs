import assert from "node:assert/strict";
import { readFile, writeFile, appendFile, mkdir, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { release } from "node:os";
import { createBridge } from "../server.mjs";
import { crc32 } from "../wire.mjs";
import { BridgeConnection } from "../client/bridge-session.js";
import { linkCore } from "../client/link-core.js";

if (/microsoft|wsl/i.test(release()))
  throw new Error(
    "Native rejoin qualification is disabled under WSL after repeated RAM/swap exhaustion. Use a separate Linux runner with hard memory and CPU limits.",
  );

const cgroup = (await readFile("/proc/self/cgroup", "utf8"))
  .split("\n")
  .find((line) => line.startsWith("0::"))
  ?.slice(3);
assert(
  cgroup !== undefined,
  "Native qualification requires cgroup v2 resource limits",
);
const limitRoot = resolve("/sys/fs/cgroup", `.${cgroup}`);
const memoryLimit = Number(
  (await readFile(resolve(limitRoot, "memory.max"), "utf8")).trim(),
);
const swapLimit = Number(
  (await readFile(resolve(limitRoot, "memory.swap.max"), "utf8")).trim(),
);
const [cpuQuota, cpuPeriod] = (
  await readFile(resolve(limitRoot, "cpu.max"), "utf8")
)
  .trim()
  .split(/\s+/)
  .map(Number);
assert(
  Number.isFinite(memoryLimit) &&
    memoryLimit > 0 &&
    memoryLimit <= 2 * 1024 ** 3,
  "Run this harness in a cgroup with MemoryMax <= 2 GiB",
);
assert(
  Number.isFinite(cpuQuota) &&
    cpuQuota > 0 &&
    cpuPeriod > 0 &&
    cpuQuota / cpuPeriod <= 2,
  "Run this harness in a cgroup with CPUQuota <= 200%",
);
assert.equal(swapLimit, 0, "Run this harness with MemorySwapMax=0");

const artifacts = process.env.NETPLAY_TEST_ARTIFACTS;
const wasm = process.env.NETPLAY_TEST_WASM;
const nativeCore = process.env.NETPLAY_TEST_NATIVE_CORE;
const coreVersion = process.env.NETPLAY_TEST_CORE_VERSION;
const system = process.env.NETPLAY_TEST_SYSTEM ?? "gba";
const romPath = resolve(
  process.env.NETPLAY_TEST_ROM ?? "test/fixtures/gba-link-1.gba",
);
const work = resolve(
  process.env.NETPLAY_TEST_OUTPUT ?? "../result/netplay-interop/native-rejoin",
);
assert(
  artifacts && wasm && nativeCore && coreVersion,
  "Provide ARTIFACTS, WASM, NATIVE_CORE and CORE_VERSION",
);
const profile =
  system === "snes"
    ? { core: "snes9x", players: 2, memoryIds: [0], sharedSave: true }
    : linkCore("mgba_splitscreen", 2);
const rom = await readFile(romPath);
const { default: init } = await import(pathToFileURL(wasm));
async function adapter() {
  const core = await init({ print() {}, printErr() {} });
  const pointer = core._malloc(rom.length);
  core.HEAPU8.set(rom, pointer);
  assert(core._probe_init(pointer, rom.length, 2));
  core._probe_step(0, 0, 0, 0);
  const size = core._probe_size(),
    state = core._malloc(size);
  return {
    size,
    profile,
    memory(id) {
      const pointer = core._probe_memory(id),
        size = core._probe_memory_size(id);
      return pointer && size
        ? core.HEAPU8.slice(pointer, pointer + size)
        : new Uint8Array();
    },
    loadMemory(id, bytes) {
      assert.equal(bytes.length, core._probe_memory_size(id));
      core.HEAPU8.set(bytes, core._probe_memory(id));
    },
    save() {
      assert(core._probe_save(state, size));
      return core.HEAPU8.slice(state, state + size);
    },
    load(bytes) {
      core.HEAPU8.set(bytes, state);
      assert(core._probe_load(state, size));
    },
    stepPlayers(buttons) {
      core._probe_step(...Array.from({ length: 4 }, (_, p) => buttons[p] ?? 0));
    },
    close() {
      core._probe_close();
      core._free(state);
      core._free(pointer);
    },
  };
}
for (const name of ["", "saves", "states", "system", "config", "data"])
  await mkdir(resolve(work, name), { recursive: true });
const initial = await adapter();
const nativeSeed = initial.memory(profile.memoryIds.at(-1));
nativeSeed.fill(79, nativeSeed.length - 64);
initial.loadMemory(profile.memoryIds.at(-1), nativeSeed);
const adminToken = randomBytes(24).toString("hex");
const bridge = await createBridge({ adminToken, portStart: 0, portEnd: 0 });
const errors = [],
  events = [],
  evidence = {};
let connection, native, log, timer, room, replacement;
const request = async (path, body) => {
  const response = await fetch(
    `http://127.0.0.1:${bridge.address.port}/v1/rooms${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  const value = await response.json();
  assert(response.ok, value.error);
  return value;
};
const connect = (core, info) =>
  new BridgeConnection(
    core,
    new WebSocket(
      `ws://127.0.0.1:${bridge.address.port}${info.hostPath ?? info.peerPath}`,
    ),
    {
      player: info.player ?? 0,
      players: 2,
      maxPrediction: 12,
      onStatus: (status) => events.push(status),
      onError: (error) => errors.push(error.message),
      onActionError: (message) => errors.push(message),
    },
  );
const wait = async (predicate, label, timeout = 15000) => {
  const end = Date.now() + timeout;
  let lastSample = 0;
  while (!predicate()) {
    if (Date.now() - lastSample >= 1000) {
      lastSample = Date.now();
      const nativeStatus = native?.pid
        ? await readFile(`/proc/${native.pid}/status`, "utf8").catch(() => "")
        : "";
      await appendFile(
        resolve(work, "resources.jsonl"),
        JSON.stringify({
          time: new Date().toISOString(),
          stage: label,
          node: process.memoryUsage(),
          nativeRssKiB: Number(/^VmRSS:\s+(\d+)/m.exec(nativeStatus)?.[1] ?? 0),
          cgroupBytes: Number(
            (
              await readFile(resolve(limitRoot, "memory.current"), "utf8")
            ).trim(),
          ),
        }) + "\n",
      );
    }
    assert.deepEqual(errors, [], label);
    assert(!room?.closed, `Room closed during ${label}`);
    assert(native?.exitCode == null, `RetroArch exited during ${label}`);
    assert(Date.now() < end, `Timed out during ${label}`);
    await delay(20);
  }
};
try {
  const info = await request("", {
    system,
    players: 2,
    coreName: system === "snes" ? "Snes9x" : "mGBA Splitscreen",
    coreVersion,
    maxPrediction: 12,
    contentCrc: crc32(rom),
    stateSize: initial.size,
    password: "",
    nativeAllowed: true,
    manualStart: true,
    owner: "lifecycle-smoke",
    nickname: "Web host",
  });
  room = bridge.rooms.get(info.id);
  connection = connect(initial, info);
  const baseline = resolve(artifacts, "native/gba-initialize-client");
  await writeFile(
    resolve(work, "options.cfg"),
    system === "snes" ? "" : await readFile(resolve(baseline, "options.cfg")),
  );
  await writeFile(
    resolve(work, "retroarch.cfg"),
    (await readFile(resolve(baseline, "retroarch.cfg"), "utf8")).replaceAll(
      baseline,
      work,
    ) + '\nlibretro_log_level = "3"\n',
  );
  log = await open(resolve(work, "run.log"), "w");
  native = spawn(
    process.env.NETPLAY_TEST_RETROARCH ??
      resolve(artifacts, "native/squashfs-root/AppRun"),
    [
      "-v",
      "-c",
      resolve(work, "retroarch.cfg"),
      "-L",
      nativeCore,
      `--port=${info.tcpPort}`,
      "--check-frames=60",
      ...(system === "snes"
        ? [romPath]
        : ["--subsystem", "gba_link_2p", romPath, romPath]),
      "--connect=127.0.0.1",
    ],
    {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: resolve(work, "config"),
        XDG_DATA_HOME: resolve(work, "data"),
      },
      stdio: ["ignore", log.fd, log.fd],
    },
  );
  native.on("error", (error) => errors.push(error.message));
  timer = setInterval(() => {
    const frame = connection?.session?.frame ?? 0;
    connection?.tick(frame % 47 < 5 ? 256 : 0);
  }, 16);
  await wait(() => room.peers.get(1)?.ready, "native lobby");
  const peer = room.peers.get(1);
  connection.assignPlayer(0, 0);
  connection.assignPlayer(1, 1);
  await wait(() => room.canStart(), "initial seat assignment");
  connection.startGame();
  await wait(() => connection.session?.confirmed >= 180, "initial gameplay");
  room.probePeers();
  await wait(() => Number.isFinite(peer.ping), "native ping");
  evidence.nativePing = peer.ping;
  const departing = connection;
  connection = null;
  departing.stop();
  await wait(() => room.peers.size === 1, "web departure");
  const before = peer.lastReportedFrame;
  await wait(
    () => peer.lastReportedFrame >= before + 120,
    "native-only gameplay",
  );
  evidence.nativeContinued = peer.lastReportedFrame - before;
  const newcomer = await request(`/${info.id}/join`, {
    nickname: "New web host",
    owner: "lifecycle-smoke-2",
    password: "",
  });
  replacement = await adapter();
  connection = connect(replacement, newcomer);
  await wait(() => connection.manualStart && room.host === 0, "new web host");
  connection.assignPlayer(0, 0);
  await wait(() => room.canStart(), "restart seat assignment");
  const waiting = peer.lastReportedFrame;
  await wait(
    () => peer.lastReportedFrame >= waiting + 60,
    "native gameplay while newcomer waits",
  );
  connection.startGame();
  await wait(
    () => connection.generation === 2 && connection.session?.confirmed >= 180,
    "native restart",
    20000,
  );
  assert.equal(room.peers.get(1), peer, "Native TCP connection was replaced");
  assert(!peer.socket.destroyed);
  assert(peer.checksSent >= 5, "Native checksum checks were not delivered");
  const battery = connection.session.confirmedMemory(profile.memoryIds.at(-1));
  assert(
    battery.slice(-64).every((value) => value === 79),
    "Native-only save progress was lost on restart",
  );
  evidence.restartFrame = connection.session.confirmed;
  evidence.nativeFrame = peer.lastReportedFrame - peer.frameOffset;
  evidence.checksSent = peer.checksSent;
  evidence.savePreserved = true;
  peer.close();
  await wait(() => room.peers.size === 1, "native departure");
  const after = connection.session.frame;
  await wait(
    () => connection.session.confirmed >= after + 120,
    "web-only gameplay",
  );
  evidence.webContinued = connection.session.confirmed - after;
  connection.stop();
  await wait(() => !bridge.rooms.has(info.id), "empty room cleanup");
  assert.deepEqual(errors, []);
  evidence.passed = true;
} finally {
  evidence.diagnostics = {
    generation: connection?.generation,
    frame: connection?.session?.frame,
    confirmed: connection?.session?.confirmed,
    paused: connection?.session?.paused,
    running: room?.running,
    starting: room?.starting,
    peers: [...(room?.peers.values() ?? [])].map((peer) => ({
      player: peer.player,
      kind: peer.kind,
      playing: peer.playing,
      nextFrame: peer.nextFrame,
      serverFrame: peer.serverFrame,
      lastReportedFrame: peer.lastReportedFrame,
      frameOffset: peer.frameOffset,
      nextWireFrame: peer.nextWireFrame,
      restartReady: peer.restartReady,
      restarting: peer.restarting,
      nativeInputsReady: peer.nativeInputsReady,
      ping: peer.ping,
    })),
  };
  clearInterval(timer);
  connection?.stop();
  if (native?.exitCode === null) {
    native.kill("SIGTERM");
    await Promise.race([
      new Promise((done) => native.once("exit", done)),
      delay(2000),
    ]);
    if (native.exitCode === null && native.signalCode === null)
      native.kill("SIGKILL");
  }
  await bridge.close();
  await log?.close();
  replacement?.close();
  initial.close();
  await writeFile(
    resolve(work, "result.json"),
    JSON.stringify({ system, ...evidence, errors, events }, null, 2) + "\n",
  );
  console.log(JSON.stringify({ system, ...evidence, errors }));
}
