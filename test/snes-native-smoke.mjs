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
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createBridge } from "../server.mjs";
import { NativePeer } from "../native.mjs";
import { CMD, crc32 } from "../wire.mjs";
import { BridgeConnection } from "../client/bridge-session.js";
import { NativeWatchdog } from "./native-watchdog.mjs";

const artifacts = process.env.NETPLAY_TEST_ARTIFACTS;
const wasm = process.env.NETPLAY_TEST_WASM;
const nativeCore = process.env.NETPLAY_TEST_NATIVE_CORE;
const coreVersion = process.env.NETPLAY_TEST_CORE_VERSION;
const romPath = process.env.NETPLAY_TEST_ROM;
const output = process.env.NETPLAY_TEST_OUTPUT;
if (![artifacts, wasm, nativeCore, coreVersion, romPath, output].every(Boolean))
  throw new Error(
    "Provide NETPLAY_TEST_ARTIFACTS, WASM, NATIVE_CORE, CORE_VERSION, ROM and OUTPUT",
  );
const work = resolve(output);
const maxPrediction = Number(process.env.NETPLAY_TEST_MAX_PREDICTION ?? 12);
const inputLatency = Number(process.env.NETPLAY_TEST_INPUT_LATENCY_MS ?? 40);
const nativeInputLag = Number(
  process.env.NETPLAY_TEST_NATIVE_INPUT_LAG_FRAMES ?? 3,
);
const target = Number(process.env.NETPLAY_TEST_FRAMES ?? 660);
const corruptCrcFrame = Number(process.env.NETPLAY_TEST_CORRUPT_CRC_FRAME ?? 0);
if (
  !Number.isInteger(maxPrediction) ||
  maxPrediction < 1 ||
  maxPrediction > 30 ||
  !Number.isInteger(inputLatency) ||
  inputLatency < 0 ||
  inputLatency > 200 ||
  !Number.isInteger(nativeInputLag) ||
  nativeInputLag < 0 ||
  nativeInputLag >= maxPrediction ||
  !Number.isInteger(target) ||
  target < 600 ||
  target > 120000 ||
  !Number.isInteger(corruptCrcFrame) ||
  corruptCrcFrame < 0 ||
  (corruptCrcFrame && (corruptCrcFrame < 120 || corruptCrcFrame % 60))
)
  throw new Error("Invalid SNES smoke test settings");
for (const directory of ["", "saves", "states", "system", "config", "data"])
  mkdirSync(resolve(work, directory), { recursive: true });
const { default: init } = await import(pathToFileURL(wasm));
const core = await init({ print() {}, printErr() {} });
const rom = readFileSync(romPath);
const romPointer = core._malloc(rom.length);
core.HEAPU8.set(rom, romPointer);
if (!core._probe_init(romPointer, rom.length))
  throw new Error("SNES ROM load failed");
core._probe_step(0, 0);
const size = core._probe_size(),
  statePointer = core._malloc(size);
const adapter = {
  size,
  memory(id) {
    const pointer = core._probe_memory(id),
      length = core._probe_memory_size(id);
    return pointer && length
      ? core.HEAPU8.slice(pointer, pointer + length)
      : new Uint8Array();
  },
  save() {
    if (!core._probe_save(statePointer, size))
      throw new Error("SNES serialization failed");
    return core.HEAPU8.slice(statePointer, statePointer + size);
  },
  load(state) {
    core.HEAPU8.set(state, statePointer);
    if (!core._probe_load(statePointer, size))
      throw new Error("SNES restore failed");
  },
  step(a, b) {
    core._probe_step(a, b);
  },
};
const sramPointer = core._probe_memory(0),
  sramLength = core._probe_memory_size(0);
if (!sramPointer || sramLength !== 2048)
  throw new Error("Expected the original 2 KiB SRAM fixture");
const expectedTail = Uint8Array.from(
  { length: 64 },
  (_, i) => (49 + i * 7) & 255,
);
core.HEAPU8.set(expectedTail, sramPointer + sramLength - expectedTail.length);
const requests = [],
  errors = [],
  events = [],
  sramSamples = [],
  socketErrors = [],
  loopGaps = [];
const padObserved = [false, false];
let nativePressedPackets = 0;
const originalCommand = NativePeer.prototype.command;
NativePeer.prototype.command = function (command, data) {
  if (command === CMD.INPUT && data.length === 12 && data.readUInt32BE(8) & 256)
    nativePressedPackets++;
  if (command === CMD.REQUEST_STATE && !this.bootstrapping)
    requests.push(this.lastReportedFrame - this.frameOffset);
  return originalCommand.call(this, command, data);
};
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
const adminToken = "isolated-snes-native-smoke-token";
const bridge = await createBridge({ adminToken, portStart: 0, portEnd: 0 });
const pendingInputs = new Set(),
  laggedInputs = [];
let connection, roomObject, peer, native, remote, timer, log, remotePort;
let frames = 0,
  batteryPreserved = false,
  finalSram = [];
let nativeBeforeCleanup = null,
  maxPollGap = 0,
  lastProgressWrite = 0;
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
        system: "snes",
        players: 2,
        coreName: "Snes9x",
        coreVersion,
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
  const relay = roomObject.relayInput.bind(roomObject);
  roomObject.relayInput = (source, f, b) => {
    if (source.kind === "native" && peer !== source) {
      peer = source;
      source.socket.on("error", (error) =>
        socketErrors.push({
          code: error.code,
          message: error.message,
          elapsed: Date.now() - startedAt,
        }),
      );
    }
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
      players: 2,
      maxPrediction,
      onStatus: (status) => events.push(status),
      onError: (error) => errors.push(error.message),
    },
  );
  const baseline = resolve(artifacts, "native/client");
  const config = readFileSync(
    resolve(baseline, "retroarch.cfg"),
    "utf8",
  ).replaceAll(baseline, work);
  writeFileSync(resolve(work, "options.cfg"), "");
  const reservation = createSocket("udp4");
  await new Promise((done, reject) => {
    reservation.once("error", reject);
    reservation.bind(0, "127.0.0.1", done);
  });
  remotePort = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  remote = createSocket("udp4");
  remote.on("error", (error) => errors.push(error.message));
  writeFileSync(
    resolve(work, "retroarch.cfg"),
    config +
      `\nlibretro_log_level = "3"\nnetwork_remote_enable = "true"\nnetwork_remote_enable_user_p1 = "true"\nnetwork_remote_base_port = "${remotePort}"\n`,
  );
  log = openSync(resolve(work, "run.log"), "w");
  native = spawn(
    process.env.NETPLAY_TEST_RETROARCH ??
      resolve(artifacts, "native/squashfs-root/AppRun"),
    [
      "-v",
      "-c",
      resolve(work, "retroarch.cfg"),
      "-L",
      nativeCore,
      `--port=${room.tcpPort}`,
      "--check-frames=60",
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
      relay(input.source, input.f, input.b);
    }
    if (!connection.started || connection.closed) return;
    const message = Buffer.alloc(20);
    message.writeInt32LE(1, 4);
    message.writeInt32LE(8, 12);
    message.writeUInt16LE(
      frames % 180 >= 120 && frames % 180 < 150 ? 1 : 0,
      16,
    );
    remote.send(message, remotePort, "127.0.0.1");
    if (frames % 10 === 0) {
      const memory = connection.session.confirmedMemory(0);
      const view = new DataView(
        memory.buffer,
        memory.byteOffset,
        memory.byteLength,
      );
      for (let player = 0; player < 2; player++)
        if (view.getUint16(player * 2, true)) padObserved[player] = true;
      if (
        sramSamples.length < 12 &&
        (view.getUint16(0, true) || view.getUint16(2, true))
      )
        sramSamples.push({
          frame: connection.session.confirmed,
          bytes: [...memory.slice(0, 8)],
        });
    }
  }, 16);
  const watchdog = new NativeWatchdog();
  for (let attempt = 0; attempt < Math.ceil(target / 4) + 100; attempt++) {
    await delay(100);
    const progress = (peer?.lastReportedFrame ?? 0) - (peer?.frameOffset ?? 0);
    const { pollGap, stalled } = watchdog.observe(progress);
    maxPollGap = Math.max(maxPollGap, pollGap);
    if (pollGap > 500 && loopGaps.length < 20)
      loopGaps.push({ elapsed: Date.now() - startedAt, milliseconds: pollGap });
    if (connection.started && Date.now() - lastProgressWrite >= 5000) {
      lastProgressWrite = Date.now();
      writeFileSync(
        resolve(work, "progress.json"),
        JSON.stringify(
          {
            elapsedMilliseconds: Date.now() - startedAt,
            frames,
            confirmed: connection.session?.confirmed,
            nativeFrame: progress,
            stats: connection.session?.stats,
            deliveredChecks: peer?.checksSent ?? 0,
            padObserved,
            nativePressedPackets,
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
      ((connection.session?.confirmed ?? 0) >= target && progress >= target)
    )
      break;
    if (connection.started && stalled) {
      errors.push("Native emulation stopped advancing for 5000 ms");
      break;
    }
  }
  if (connection.session) {
    const memory = connection.session.confirmedMemory(0);
    finalSram = [...memory.slice(0, 8)];
    batteryPreserved = expectedTail.every(
      (value, i) => value === memory[sramLength - 64 + i],
    );
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
const nativeFrame = (peer?.lastReportedFrame ?? 0) - (peer?.frameOffset ?? 0);
const stats = connection?.session?.stats;
const passed =
  frames >= target &&
  nativeFrame >= target &&
  (peer?.checksSent ?? 0) >= 10 &&
  batteryPreserved &&
  padObserved.every(Boolean) &&
  nativePressedPackets > 0 &&
  (!(inputLatency || nativeInputLag) || (stats?.rollbacks ?? 0) > 0) &&
  !errors.length &&
  !requests.length;
const result = {
  passed,
  coreVersion,
  stateSize: size,
  maxPrediction,
  inputLatency,
  nativeInputLag,
  corruptCrcFrame,
  frames,
  nativeFrame,
  deliveredChecks: peer?.checksSent ?? 0,
  stats,
  batteryPreserved,
  padObserved,
  nativePressedPackets,
  finalSram,
  sramSamples,
  nativeBeforeCleanup,
  socketErrors,
  maxPollGap,
  loopGaps,
  requests,
  errors,
  events,
  elapsedMilliseconds: Date.now() - startedAt,
};
writeFileSync(
  resolve(work, "result.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
if (!passed) process.exitCode = 1;
