/** Exercise the untouched stock frontend and core using the artifact layout in README.md. */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  openSync,
  closeSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBridge } from "../server.mjs";
import { NativePeer } from "../native.mjs";
import { crc32 } from "../wire.mjs";
import { BridgeConnection } from "../client/bridge-session.js";
import { calibrateSameBoy } from "../client/bridge-calibration.js";
import { linkCore } from "../client/link-core.js";
import { NativeWatchdog } from "./native-watchdog.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = process.env.NETPLAY_TEST_ARTIFACTS;
if (!artifacts)
  throw new Error(
    "Set NETPLAY_TEST_ARTIFACTS to the separately prepared stock-core directory",
  );
const romPath =
  process.env.NETPLAY_TEST_ROM ??
  resolve(repository, "test/fixtures/link-1.gb");
const work = resolve(
  process.env.NETPLAY_TEST_OUTPUT ?? resolve(artifacts, "native/gateway-smoke"),
);
const warmup = Number(process.env.NETPLAY_TEST_WARMUP ?? 1);
const handshakeDelay = Number(process.env.NETPLAY_TEST_HANDSHAKE_DELAY_MS ?? 0);
const maxPrediction = Number(process.env.NETPLAY_TEST_MAX_PREDICTION ?? 0);
const inputLatency = Number(process.env.NETPLAY_TEST_INPUT_LATENCY_MS ?? 0);
const nativeInputLag = Number(
  process.env.NETPLAY_TEST_NATIVE_INPUT_LAG_FRAMES ?? 0,
);
const targetFrames = Number(process.env.NETPLAY_TEST_FRAMES ?? 600);
const minimumDuration = Number(process.env.NETPLAY_TEST_DURATION_MS ?? 0);
const corruptCrcFrame = Number(process.env.NETPLAY_TEST_CORRUPT_CRC_FRAME ?? 0);
const remoteInputEnabled = process.env.NETPLAY_TEST_REMOTE_INPUT === "1";
if (
  !Number.isInteger(maxPrediction) ||
  maxPrediction < 0 ||
  maxPrediction > 30 ||
  !Number.isInteger(inputLatency) ||
  inputLatency < 0 ||
  inputLatency > 200 ||
  !Number.isInteger(nativeInputLag) ||
  nativeInputLag < 0 ||
  (nativeInputLag > 0 && nativeInputLag >= maxPrediction) ||
  !Number.isInteger(minimumDuration) ||
  minimumDuration < 0 ||
  minimumDuration > 3600000 ||
  !Number.isInteger(corruptCrcFrame) ||
  corruptCrcFrame < 0 ||
  (corruptCrcFrame > 0 &&
    (corruptCrcFrame < 120 || corruptCrcFrame % 60 !== 0)) ||
  !Number.isInteger(targetFrames) ||
  targetFrames < 600 ||
  targetFrames > 120000
)
  throw new Error("Invalid rollback smoke test settings");
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
if (
  !Number.isInteger(warmup) ||
  warmup < 1 ||
  warmup > 600 ||
  !Number.isInteger(handshakeDelay) ||
  handshakeDelay < 0 ||
  handshakeDelay > 5000
)
  throw new Error("Invalid smoke test timing");
if (handshakeDelay) {
  const original = NativePeer.prototype.header;
  NativePeer.prototype.header = function (bytes) {
    setTimeout(() => original.call(this, bytes), handshakeDelay);
  };
}
const { default: init } = await import(
  pathToFileURL(
    process.env.NETPLAY_TEST_WASM ?? resolve(artifacts, "core-probe.mjs"),
  )
);
const core = await init({ print() {}, printErr() {} });
const rom = readFileSync(romPath),
  romPointer = core._malloc(rom.length);
core.HEAPU8.set(rom, romPointer);
if (!core._probe_init(romPointer, rom.length))
  throw new Error("Stock WASM core load failed");
for (let frame = 0; frame < warmup; frame++) core._probe_step(0, 0);
const size = core._probe_size(),
  statePointer = core._malloc(size);
const adapter = {
  size,
  profile: linkCore("sameboy"),
  memory: () => new Uint8Array(),
  save() {
    if (!core._probe_save(statePointer, size))
      throw new Error("Core serialization failed");
    return core.HEAPU8.slice(statePointer, statePointer + size);
  },
  load(bytes) {
    core.HEAPU8.set(bytes, statePointer);
    if (!core._probe_load(statePointer, size))
      throw new Error("Core state load failed");
  },
  step(a, b) {
    core._probe_step(a, b);
  },
};
const seededRanges = [];
if (process.env.NETPLAY_TEST_BATTERY_SEED !== undefined) {
  const seed = Number(process.env.NETPLAY_TEST_BATTERY_SEED);
  if (!Number.isInteger(seed) || seed < 0 || seed > 255 || rom[0x149] !== 3)
    throw new Error(
      "Battery seeding requires a 32 KiB RAM fixture and a byte seed",
    );
  const state = adapter.save(),
    view = new DataView(state.buffer);
  const offsets = [0];
  for (let at = 8; at + 8 < state.length; at++)
    if (
      state[at - 4] === 0x42 &&
      state[at - 3] === 0x45 &&
      state[at - 2] === 0x53 &&
      state[at - 1] === 0x53 &&
      state[at] === 0x45 &&
      state[at + 1] === 0x4d &&
      state[at + 2] === 0x41 &&
      state[at + 3] === 0x53
    )
      offsets.push(at);
  if (offsets.length !== 2)
    throw new Error("Unexpected linked fixture state layout");
  for (const [player, offset] of offsets.entries()) {
    let start = offset + 8;
    for (let section = 0; section < 9; section++)
      start += 4 + view.getUint32(start, true);
    if (start + 32768 > state.length)
      throw new Error("Invalid battery state extent");
    for (let index = 0; index < 32768; index++)
      state[start + index] = (seed + player * 64 + index * 7) & 255;
    seededRanges.push({ start, expected: state.slice(start, start + 32768) });
  }
  adapter.load(state);
}
const adminToken = "isolated-stock-native-smoke-test-token";
const bridge = await createBridge({ adminToken, portStart: 0, portEnd: 0 });
let connection, native, nativePeer, log, timer, remote, roomObject;
let remotePort = 0,
  remotePackets = 0;
const pendingInputs = new Set();
const laggedInputs = [];
const events = [],
  requests = [],
  errors = [];
const socketErrors = [],
  loopGaps = [];
let nativeBeforeCleanup = null,
  maxPollGap = 0;
let frames = 0,
  checks = 0,
  nativeFrame = 0,
  deliveredChecks = 0,
  batteryPreserved = null;
let startedAt = 0,
  elapsedMilliseconds = 0,
  lastProgressWrite = 0;
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
        system: "gb",
        players: 2,
        coreName: "SameBoy",
        coreVersion: process.env.NETPLAY_TEST_CORE_VERSION ?? "1.0.4 c87d256",
        maxPrediction,
        contentCrc: crc32(rom),
        stateSize: size,
        password: "",
        nativeAllowed: true,
        ...(process.env.NETPLAY_TEST_CALIBRATION === "off"
          ? {}
          : { nativeCalibration: "sameboy-v1" }),
      }),
    },
  );
  const room = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(room));
  roomObject = bridge.rooms.get(room.id);
  const relay = roomObject.relayInput.bind(roomObject);
  roomObject.relayInput = (peer, f, b) => {
    if (peer.kind === "native" && nativePeer !== peer) {
      nativePeer = peer;
      peer.socket.on("error", (error) =>
        socketErrors.push({
          code: error.code,
          message: error.message,
          elapsed: Date.now() - startedAt,
        }),
      );
    }
    if (peer.kind === "native" && b) remotePackets++;
    // An unthrottled native frontend can run far ahead of the browser clock.
    if (peer.kind === "native" && nativeInputLag) {
      if (laggedInputs.length >= 240)
        throw new Error("Diagnostic native input queue exceeded");
      laggedInputs.push({ peer, f, b, due: Date.now() + inputLatency });
      return;
    }
    if (!inputLatency) return relay(peer, f, b);
    const task = setTimeout(() => {
      pendingInputs.delete(task);
      if (!roomObject.closed) relay(peer, f, b);
    }, inputLatency);
    pendingInputs.add(task);
  };
  const socket = new WebSocket(
    `ws://127.0.0.1:${bridge.address.port}${room.hostPath}`,
  );
  socket.addEventListener("message", ({ data }) => {
    if (typeof data !== "string") return;
    const packet = JSON.parse(data);
    if (packet.t === "state-request") requests.push(packet.f);
    if (packet.t === "peer-error") errors.push(packet.message);
  });
  connection = new BridgeConnection(adapter, socket, {
    player: 0,
    players: 2,
    maxPrediction,
    calibrate: calibrateSameBoy,
    onStatus: (status) => {
      events.push(status);
      if (status === "connected" && !startedAt) startedAt = Date.now();
    },
    onError: (error) => errors.push(error.message),
  });
  for (const name of ["", "saves", "states", "system", "config", "data"])
    mkdirSync(resolve(work, name), { recursive: true });
  writeFileSync(
    resolve(work, "options.cfg"),
    readFileSync(resolve(artifacts, "native/client/options.cfg")),
  );
  const baseline = resolve(artifacts, "native/client");
  const config = readFileSync(
    resolve(baseline, "retroarch.cfg"),
    "utf8",
  ).replaceAll(baseline, work);
  let remoteConfig = "";
  if (remoteInputEnabled) {
    const reservation = createSocket("udp4");
    await new Promise((done) => reservation.bind(0, "127.0.0.1", done));
    remotePort = reservation.address().port;
    await new Promise((done) => reservation.close(done));
    remote = createSocket("udp4");
    remote.on("error", (error) => errors.push(error.message));
    remoteConfig = `\nnetwork_remote_enable = "true"\nnetwork_remote_enable_user_p1 = "true"\nnetwork_remote_base_port = "${remotePort}"\n`;
  }
  writeFileSync(
    resolve(work, "retroarch.cfg"),
    config + remoteConfig + '\nlibretro_log_level = "3"\n',
  );
  await delay(50);
  log = openSync(resolve(work, "run.log"), "w");
  native = spawn(
    resolve(artifacts, "native/squashfs-root/AppRun"),
    [
      "-v",
      "-c",
      resolve(work, "retroarch.cfg"),
      "-L",
      process.env.NETPLAY_TEST_NATIVE_CORE ??
        resolve(artifacts, "native/sameboy_libretro.so"),
      `--port=${room.tcpPort}`,
      "--check-frames=60",
      "--subsystem",
      "gb_link_2p",
      romPath,
      romPath,
      "--connect=127.0.0.1",
    ],
    {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: resolve(work, "config"),
        XDG_DATA_HOME: resolve(work, "data"),
      },
      stdio: ["ignore", log, log],
    },
  );
  native.on("error", (error) => errors.push(error.message));
  timer = setInterval(() => {
    if (connection.tick(frames % 17 < 5 ? 256 : 0)) frames++;
    while (
      !roomObject.closed &&
      laggedInputs.length &&
      laggedInputs[0].f + nativeInputLag <= (connection.session?.frame ?? 0) &&
      laggedInputs[0].due <= Date.now()
    ) {
      const input = laggedInputs.shift();
      relay(input.peer, input.f, input.b);
    }
    if (remote && connection.started) {
      const message = Buffer.alloc(20);
      message.writeInt32LE(1, 4);
      message.writeInt32LE(8, 12);
      message.writeUInt16LE(
        frames % 180 >= 120 && frames % 180 < 150 ? 1 : 0,
        16,
      );
      remote.send(message, remotePort, "127.0.0.1");
    }
  }, 16);
  const watchdog = new NativeWatchdog();
  for (
    let attempt = 0;
    attempt < Math.ceil(targetFrames / 4) + 100;
    attempt++
  ) {
    await delay(100);
    const progress =
      (nativePeer?.lastReportedFrame ?? 0) - (nativePeer?.frameOffset ?? 0);
    const { pollGap, stalled } = watchdog.observe(progress);
    maxPollGap = Math.max(maxPollGap, pollGap);
    if (pollGap > 500 && loopGaps.length < 20)
      loopGaps.push({
        elapsed: startedAt ? Date.now() - startedAt : 0,
        milliseconds: pollGap,
      });
    elapsedMilliseconds = startedAt ? Date.now() - startedAt : 0;
    if (startedAt && Date.now() - lastProgressWrite >= 5000) {
      lastProgressWrite = Date.now();
      writeFileSync(
        resolve(work, "progress.json"),
        JSON.stringify(
          {
            elapsedMilliseconds,
            frames,
            confirmed: connection.session?.confirmed,
            nativeFrame: progress,
            stats: connection.session?.stats,
            deliveredChecks: nativePeer?.checksSent ?? 0,
            errors,
          },
          null,
          2,
        ) + "\n",
      );
    }
    if (connection.started && stalled) {
      errors.push("Native emulation stopped advancing for 5000 ms");
      break;
    }
    if (
      connection.closed ||
      native.exitCode !== null ||
      ((connection.session?.confirmed ?? frames) >= targetFrames &&
        elapsedMilliseconds >= minimumDuration)
    )
      break;
  }
  checks = connection.session?.stats.checks ?? 0;
  nativePeer ??= roomObject?.peers.get(1);
  nativeFrame =
    (nativePeer?.lastReportedFrame ?? 0) - (nativePeer?.frameOffset ?? 0);
  deliveredChecks = nativePeer?.checksSent ?? 0;
  if (seededRanges.length) {
    const final = adapter.save();
    batteryPreserved = seededRanges.every(({ start, expected }) =>
      expected.every((byte, index) => final[start + index] === byte),
    );
  }
} finally {
  nativeBeforeCleanup = native
    ? {
        exitCode: native.exitCode,
        signalCode: native.signalCode,
        socketDestroyed: nativePeer?.socket.destroyed ?? null,
        socketReadableEnded: nativePeer?.socket.readableEnded ?? null,
      }
    : null;
  clearInterval(timer);
  for (const task of pendingInputs) clearTimeout(task);
  laggedInputs.length = 0;
  if (remote) await new Promise((done) => remote.close(done));
  connection?.stop();
  await bridge.close();
  native?.kill("SIGTERM");
  await delay(300);
  if (native && native.exitCode === null) native.kill("SIGKILL");
  if (log !== undefined) closeSync(log);
  core._probe_close();
}
const passed =
  elapsedMilliseconds >= minimumDuration &&
  frames >= targetFrames &&
  nativeFrame >= targetFrames &&
  checks >= 10 &&
  deliveredChecks >= 10 &&
  (!remoteInputEnabled || remotePackets > 0) &&
  (!(maxPrediction && (inputLatency || nativeInputLag) && remoteInputEnabled) ||
    (connection.session?.stats.rollbacks ?? 0) > 0) &&
  batteryPreserved !== false &&
  requests.length === 0 &&
  errors.length === 0;
const result = {
  passed,
  calibration: process.env.NETPLAY_TEST_CALIBRATION !== "off",
  warmup,
  handshakeDelay,
  maxPrediction,
  inputLatency,
  nativeInputLag,
  elapsedMilliseconds,
  minimumDuration,
  corruptCrcFrame,
  remotePackets,
  stats: connection?.session?.stats,
  frames,
  nativeFrame,
  checks,
  deliveredChecks,
  batteryPreserved,
  nativeBeforeCleanup,
  socketErrors,
  maxPollGap,
  loopGaps,
  requests,
  errors,
  events,
};
writeFileSync(
  resolve(work, "result.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
if (!passed) process.exitCode = 1;
