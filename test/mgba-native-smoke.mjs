import { readFile, writeFile, mkdir, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { createBridge } from "../server.mjs";
import { NativePeer } from "../native.mjs";
import { CMD, crc32, readStatePayload } from "../wire.mjs";
import { BridgeConnection } from "../client/bridge-session.js";
import { linkCore } from "../client/link-core.js";
import { NativeWatchdog } from "./native-watchdog.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = process.env.NETPLAY_TEST_ARTIFACTS;
if (!artifacts)
  throw new Error(
    "Set NETPLAY_TEST_ARTIFACTS to the prepared stock-core directory",
  );
const { default: init } = await import(
  pathToFileURL(
    process.env.NETPLAY_TEST_WASM ?? resolve(artifacts, "gba-probe.mjs"),
  )
);
const players = Number(process.argv[2] ?? 2);
const warmup = Number(process.argv[3] ?? 1);
const handshakeDelay = Number(process.argv[4] ?? 0);
const target = Number(process.argv[5] ?? 660);
const remoteInputEnabled = process.env.NETPLAY_TEST_REMOTE_INPUT === "1";
const maxPrediction = Number(process.env.NETPLAY_TEST_MAX_PREDICTION ?? 0);
const inputLatency = Number(process.env.NETPLAY_TEST_INPUT_LATENCY_MS ?? 0);
const nativeInputLag = Number(
  process.env.NETPLAY_TEST_NATIVE_INPUT_LAG_FRAMES ?? 0,
);
const corruptCrcFrame = Number(process.env.NETPLAY_TEST_CORRUPT_CRC_FRAME ?? 0);
if (
  players !== 2 ||
  !Number.isInteger(target) ||
  target < 600 ||
  target > 120000 ||
  !Number.isInteger(maxPrediction) ||
  maxPrediction < 0 ||
  maxPrediction > 30 ||
  !Number.isInteger(inputLatency) ||
  inputLatency < 0 ||
  inputLatency > 200 ||
  !Number.isInteger(nativeInputLag) ||
  nativeInputLag < 0 ||
  (nativeInputLag > 0 && nativeInputLag >= maxPrediction) ||
  !Number.isInteger(corruptCrcFrame) ||
  corruptCrcFrame < 0 ||
  (corruptCrcFrame > 0 &&
    (corruptCrcFrame < 120 || corruptCrcFrame % 60 !== 0)) ||
  !Number.isInteger(warmup) ||
  warmup < 1 ||
  warmup > 600 ||
  !Number.isInteger(handshakeDelay) ||
  handshakeDelay < 0 ||
  handshakeDelay > 5000
)
  throw new Error("Invalid smoke test settings; this harness uses two players");
const work = resolve(
  process.env.NETPLAY_TEST_OUTPUT ??
    resolve(
      artifacts,
      `native/gba-gateway-${players}p-w${warmup}-d${handshakeDelay}`,
    ),
);
await mkdir(work, { recursive: true });
const romPath = resolve(repository, "test/fixtures/gba-link-1.gba");
const rom = await readFile(romPath);
const events = [],
  errors = [],
  requests = [],
  captured = [],
  checkpoints = [];
const states = new Map();
const pendingInputs = new Set(),
  laggedInputs = [],
  batterySeeds = [];
let relay,
  batteryPreserved = null;
let frames = 0,
  lastProgressWrite = 0,
  maxPollGap = 0;
const loopGaps = [];
const pressFrames = [];
for (let frame = 120; frame < target - 60; frame += 180)
  pressFrames.push(frame);
let nativeBeforeCleanup = null;
let connection, native, log, timer, roomObject, peer, remote;
let remotePort = 0,
  remotePhase = "idle",
  remotePresses = 0,
  lastRemoteSend = 0,
  ending = false;
const remoteInput = {
  enabled: remoteInputEnabled,
  expectedPresses: pressFrames.length,
  actualPresses: 0,
  receivedPressedPackets: 0,
};
const core = await init({ print() {}, printErr() {} });
const romPointer = core._malloc(rom.length);
core.HEAPU8.set(rom, romPointer);
if (!core._probe_init(romPointer, rom.length, players))
  throw new Error("WASM core load failed");
for (let frame = 0; frame < warmup; frame++) core._probe_step(0, 0, 0, 0);
const size = core._probe_size(),
  statePointer = core._malloc(size);
const adapter = {
  size,
  profile: linkCore("mgba_splitscreen", players),
  memory(id) {
    const pointer = core._probe_memory(id),
      length = core._probe_memory_size(id);
    return pointer && length
      ? core.HEAPU8.slice(pointer, pointer + length)
      : new Uint8Array();
  },
  save() {
    if (!core._probe_save(statePointer, size))
      throw new Error("WASM state save failed");
    const state = core.HEAPU8.slice(statePointer, statePointer + size);
    if (!maxPrediction) {
      states.set(frames, state);
      for (const frame of states.keys())
        if (frame < frames - 16) states.delete(frame);
    }
    return state;
  },
  load(state) {
    core.HEAPU8.set(state, statePointer);
    if (!core._probe_load(statePointer, size))
      throw new Error("WASM state restore failed");
  },
  step(a, b) {
    core._probe_step(a, b, 0, 0);
    if (!maxPrediction) frames++;
  },
  stepPlayers(buttons) {
    core._probe_step(...Array.from({ length: 4 }, (_, p) => buttons[p] ?? 0));
    if (!maxPrediction) frames++;
  },
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (maxPrediction) {
  for (const id of [0, 256]) {
    const pointer = core._probe_memory(id),
      length = core._probe_memory_size(id);
    if (!pointer || length < 128)
      throw new Error("Fixture SRAM is unavailable");
    const expected = Uint8Array.from(
      { length: 64 },
      (_, i) => ((id ? 113 : 49) + i * 7) & 255,
    );
    core.HEAPU8.set(expected, pointer + length - 64);
    batterySeeds.push({ id, offset: length - 64, expected });
  }
}
const first = adapter.save();
await writeFile(work + "/web-initial.bin", first);
const originalCommand = NativePeer.prototype.command;
if (corruptCrcFrame) {
  const sendCrc = NativePeer.prototype.sendCrc;
  NativePeer.prototype.sendCrc = function (frame, crc) {
    return sendCrc.call(
      this,
      frame,
      frame === corruptCrcFrame ? (crc ^ 1) >>> 0 : crc,
    );
  };
}
NativePeer.prototype.command = function (command, data) {
  if (command === CMD.INPUT && data.length === 12 && data.readUInt32BE(8) & 256)
    remoteInput.receivedPressedPackets++;
  if (command === CMD.REQUEST_STATE && !this.bootstrapping)
    requests.push({ nativeFrame: this.lastReportedFrame, webFrame: frames });
  if (command === CMD.LOAD_STATE && this.diagnosticCapture) {
    this.diagnosticCapture = false;
    const decoded = readStatePayload(
      data,
      this.protocol,
      this.compressed,
      size,
    );
    captured.push({
      frame: decoded.frame - this.frameOffset,
      state: Buffer.from(decoded.state),
    });
    return;
  }
  return originalCommand.call(this, command, data);
};
if (handshakeDelay) {
  const originalHeader = NativePeer.prototype.header;
  NativePeer.prototype.header = function (data) {
    setTimeout(() => {
      if (!this.socket.destroyed) originalHeader.call(this, data);
    }, handshakeDelay);
  };
}
const adminToken = randomBytes(24).toString("hex");
const bridge = await createBridge({ adminToken, portStart: 0, portEnd: 0 });
const milestone = new Set([180, 360, 600]);
const startedAt = Date.now();
try {
  const response = await fetch(
    `http://127.0.0.1:${bridge.address.port}/v1/rooms`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        system: "gba",
        players,
        coreName: "mGBA Splitscreen",
        coreVersion: process.env.NETPLAY_TEST_CORE_VERSION ?? "0.1.0",
        maxPrediction,
        contentCrc: crc32(rom),
        stateSize: size,
        password: "",
        nativeAllowed: true,
      }),
    },
  );
  const room = await response.json();
  if (!response.ok) throw new Error(room.error);
  roomObject = bridge.rooms.get(room.id);
  relay = roomObject.relayInput.bind(roomObject);
  roomObject.relayInput = (source, f, b) => {
    if (source.kind === "native") peer = source;
    if (source.kind === "native" && nativeInputLag) {
      if (laggedInputs.length >= 240)
        throw new Error("Diagnostic native input queue exceeded");
      laggedInputs.push({ source, f, b, due: Date.now() + inputLatency });
      return;
    }
    if (!inputLatency) return relay(source, f, b);
    const task = setTimeout(() => {
      pendingInputs.delete(task);
      if (!roomObject.closed) relay(source, f, b);
    }, inputLatency);
    pendingInputs.add(task);
  };
  connection = new BridgeConnection(
    adapter,
    new WebSocket(`ws://127.0.0.1:${bridge.address.port}${room.hostPath}`),
    {
      player: 0,
      players,
      maxPrediction,
      onStatus: (status) => events.push(status),
      onError: (error) => errors.push(error.message),
    },
  );
  if (players !== 2)
    throw new Error("Mixed 3/4 player smoke requires additional web peers");
  for (const name of ["saves", "states", "system", "config", "data"])
    await mkdir(work + "/" + name, { recursive: true });
  const baseline = resolve(artifacts, "native/gba-initialize-client");
  await writeFile(
    work + "/options.cfg",
    await readFile(baseline + "/options.cfg"),
  );
  const config = (
    await readFile(baseline + "/retroarch.cfg", "utf8")
  ).replaceAll(baseline, work);
  let remoteConfig = "";
  if (remoteInputEnabled) {
    const reservation = createSocket("udp4");
    await new Promise((resolve, reject) => {
      reservation.once("error", reject);
      reservation.bind(0, "127.0.0.1", resolve);
    });
    remotePort = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    remote = createSocket("udp4");
    remote.on("error", (error) => {
      if (!ending) errors.push(error.message);
    });
    remoteConfig = `\nnetwork_remote_enable = "true"\nnetwork_remote_enable_user_p1 = "true"\nnetwork_remote_base_port = "${remotePort}"\n`;
  }
  await writeFile(
    work + "/retroarch.cfg",
    config + '\nlibretro_log_level = "3"\n' + remoteConfig,
  );
  log = await open(work + "/run.log", "w");
  native = spawn(
    process.env.NETPLAY_TEST_RETROARCH ??
      resolve(artifacts, "native/squashfs-root/AppRun"),
    [
      "-v",
      "-c",
      work + "/retroarch.cfg",
      "-L",
      process.env.NETPLAY_TEST_NATIVE_CORE ??
        resolve(
          artifacts,
          "mgba-initialize-build/mgba_splitscreen_libretro.so",
        ),
      "--port=" + room.tcpPort,
      "--check-frames=60",
      "--subsystem",
      "gba_link_2p",
      romPath,
      romPath,
      "--connect=127.0.0.1",
    ],
    {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: work + "/config",
        XDG_DATA_HOME: work + "/data",
      },
      stdio: ["ignore", log.fd, log.fd],
    },
  );
  native.on("error", (error) => errors.push(error.message));
  timer = setInterval(() => {
    peer = roomObject.peers.get(1) ?? peer;
    const nativeFrame =
      (peer?.lastReportedFrame ?? 0) - (peer?.frameOffset ?? 0);
    if (frames > nativeFrame + 6) return;
    if (connection.tick(frames % 17 < 5 ? 256 : 0) && maxPrediction) frames++;
    while (
      !roomObject.closed &&
      laggedInputs.length &&
      laggedInputs[0].f + nativeInputLag <= (connection.session?.frame ?? 0) &&
      laggedInputs[0].due <= Date.now()
    ) {
      const input = laggedInputs.shift();
      relay(input.source, input.f, input.b);
    }
    if (remoteInputEnabled) {
      const memory =
        maxPrediction && connection.session
          ? connection.session.confirmedMemory(256)
          : adapter.memory(256);
      const saved = new DataView(
        memory.buffer,
        memory.byteOffset,
        memory.byteLength,
      );
      remoteInput.actualPresses = saved.getUint32(4, true);
      if (
        remotePhase === "idle" &&
        remotePresses < pressFrames.length &&
        frames >= pressFrames[remotePresses]
      )
        remotePhase = "press";
      if (
        remotePhase === "press" &&
        remoteInput.actualPresses >= remotePresses + 1
      )
        remotePhase = "release";
      if (
        remotePhase === "release" &&
        (saved.getUint32(24, true) & 1) === 0 &&
        !(peer?.buttons & 256)
      ) {
        remotePresses++;
        remotePhase = "idle";
      }
      if (remotePhase !== "idle" && Date.now() - lastRemoteSend >= 50) {
        const message = Buffer.alloc(20);
        message.writeInt32LE(1, 4);
        message.writeInt32LE(8, 12);
        message.writeUInt16LE(remotePhase === "press" ? 1 : 0, 16);
        remote.send(message, remotePort, "127.0.0.1");
        lastRemoteSend = Date.now();
      }
    }
    if (
      !maxPrediction &&
      milestone.has(frames) &&
      peer &&
      !peer.diagnosticCapture
    ) {
      milestone.delete(frames);
      peer.diagnosticCapture = true;
      peer.send(CMD.REQUEST_STATE);
    }
    for (const sample of captured) {
      if (sample.compared || !states.has(sample.frame)) continue;
      const expected = states.get(sample.frame),
        diffs = [];
      for (let at = 0; at < size; at++)
        if (sample.state[at] !== expected[at]) {
          if (diffs.length < 24)
            diffs.push({ at, native: sample.state[at], web: expected[at] });
        }
      checkpoints.push({
        frame: sample.frame,
        equal: sample.state.equals(expected),
        nativeSha256: hash(sample.state),
        webSha256: hash(expected),
        firstDifferences: diffs,
      });
      sample.compared = true;
    }
  }, 16);
  const watchdog = new NativeWatchdog();
  for (let attempt = 0; attempt < Math.ceil(target / 4) + 100; attempt++) {
    await delay(100);
    const nativeFrame =
      (peer?.lastReportedFrame ?? 0) - (peer?.frameOffset ?? 0);
    const { pollGap, stalled } = watchdog.observe(nativeFrame);
    maxPollGap = Math.max(maxPollGap, pollGap);
    if (pollGap > 500 && loopGaps.length < 20)
      loopGaps.push({ elapsed: Date.now() - startedAt, milliseconds: pollGap });
    if (connection.started && Date.now() - lastProgressWrite >= 5000) {
      lastProgressWrite = Date.now();
      await writeFile(
        work + "/progress.json",
        JSON.stringify(
          {
            elapsedMilliseconds: Date.now() - startedAt,
            frames,
            confirmed: connection.session?.confirmed,
            nativeFrame,
            stats: connection.session?.stats,
            deliveredChecks: peer?.checksSent ?? 0,
            remoteInput,
            maxPollGap,
            loopGaps,
            errors,
          },
          null,
          2,
        ) + "\n",
      );
    }
    if (
      connection.closed ||
      native.exitCode !== null ||
      ((connection.session?.confirmed ?? frames) >= target &&
        nativeFrame >= target)
    )
      break;
    if (connection.started && stalled) {
      errors.push("Native emulation stopped advancing for 5000 ms");
      break;
    }
  }
  if (batterySeeds.length) {
    batteryPreserved = batterySeeds.every(({ id, offset, expected }) => {
      const actual = connection.session.confirmedMemory(id);
      return expected.every((value, i) => value === actual[offset + i]);
    });
  }
} catch (error) {
  errors.push(error.stack);
} finally {
  nativeBeforeCleanup = native
    ? {
        exitCode: native.exitCode,
        signalCode: native.signalCode,
        socketDestroyed: peer?.socket.destroyed ?? null,
        socketReadableEnded: peer?.socket.readableEnded ?? null,
      }
    : null;
  ending = true;
  clearInterval(timer);
  for (const task of pendingInputs) clearTimeout(task);
  laggedInputs.length = 0;
  if (remote) await new Promise((resolve) => remote.close(resolve));
  connection?.stop();
  await bridge.close();
  native?.kill("SIGTERM");
  if (native && native.exitCode === null)
    await Promise.race([
      new Promise((resolve) => native.once("exit", resolve)),
      delay(500),
    ]);
  if (native && native.exitCode === null) {
    native.kill("SIGKILL");
    await delay(100);
  }
  await log?.close();
  core._probe_close();
}
const nativeFrame = (peer?.lastReportedFrame ?? 0) - (peer?.frameOffset ?? 0);
for (const sample of captured)
  await writeFile(work + `/native-frame-${sample.frame}.bin`, sample.state);
const passed =
  frames >= target &&
  nativeFrame >= target &&
  (peer?.checksSent ?? 0) >= 10 &&
  requests.length === 0 &&
  errors.length === 0 &&
  batteryPreserved !== false &&
  (maxPrediction
    ? !(inputLatency || nativeInputLag) ||
      !remoteInputEnabled ||
      (connection.session?.stats.rollbacks ?? 0) > 0
    : checkpoints.length >= 3) &&
  checkpoints.every((sample) => sample.equal) &&
  (!remoteInputEnabled ||
    (remoteInput.actualPresses === remoteInput.expectedPresses &&
      remoteInput.receivedPressedPackets > 0));
const result = {
  passed,
  web: process.env.NETPLAY_TEST_WASM ?? "untouched upstream WASM",
  native:
    process.env.NETPLAY_TEST_NATIVE_CORE ??
    "upstream plus MUST_INITIALIZE only",
  frontend: process.env.NETPLAY_TEST_RETROARCH ?? "untouched RetroArch 1.22.2",
  players,
  warmup,
  handshakeDelay,
  maxPrediction,
  inputLatency,
  nativeInputLag,
  corruptCrcFrame,
  batteryPreserved,
  stats: connection.session?.stats,
  stateSize: size,
  stateVersion: first[4],
  frames,
  nativeFrame,
  deliveredChecks: peer?.checksSent ?? 0,
  requests,
  errors,
  events,
  checkpoints,
  remoteInput,
  nativeBeforeCleanup,
  maxPollGap,
  loopGaps,
  elapsedMilliseconds: Date.now() - startedAt,
};
await writeFile(work + "/result.json", JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
if (!passed) process.exitCode = 1;
