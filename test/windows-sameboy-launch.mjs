import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createTcpServer, connect } from "node:net";
import { createSocket } from "node:dgram";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { createBridge } from "../server.mjs";
import { CMD, crc32, words } from "../wire.mjs";
import { linkCore } from "../client/link-core.js";

assert.equal(process.platform, "win32", "Use windows-bounded.exe");
const work = resolve(process.argv[2]);
const saveSync = process.argv.includes("--save-sync");
const checkpointLag = process.argv.includes("--checkpoint-lag");
const startupHeartbeat = process.argv.includes("--startup-heartbeat");
const latencyMs = saveSync ? 35 : 0;
const coreId =
  process.argv.find((arg) => arg.startsWith("--core="))?.slice(7) ?? "sameboy";
const profiles = {
  sameboy: {
    system: "gb",
    coreName: "SameBoy",
    coreVersion: "1.0.4c87d256-cable1",
    extension: "gb",
    ...linkCore("sameboy"),
  },
  mgba_splitscreen: {
    system: "gba",
    coreName: "mGBA Splitscreen",
    coreVersion: "0.1.0-f1d5975-cable1",
    extension: "gba",
    ...linkCore("mgba_splitscreen"),
  },
  snes9x: {
    system: "snes",
    coreName: "Snes9x",
    coreVersion: "1.632d4cce69",
    extension: "sfc",
    saveSize: 2048,
    subsystem: "",
    options: {},
  },
};
const profile = profiles[coreId];
assert(profile, "Unsupported native test core");
const output = resolve(work, "evidence");
await mkdir(output, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const roms = await Promise.all(
  (coreId === "snes9x" ? [1] : [1, 2]).map((n) =>
    readFile(resolve(work, `player-${n}.${profile.extension}`)),
  ),
);
const dllName = `${coreId}_libretro.dll`;
const infoName = `${coreId}_libretro.info`;
const dll = await readFile(resolve(work, dllName));
const info =
  coreId === "snes9x" ? null : await readFile(resolve(work, infoName));
const cartridges = roms.map((bytes, p) => ({
  romId: p + 11,
  size: bytes.length,
  crc32: crc32(bytes),
  sha256: hash(bytes),
}));
const cartridgeFor = (player) => cartridges[coreId === "snes9x" ? 0 : player];
const events = [],
  errors = [],
  children = [],
  sockets = [],
  manifests = [],
  downloads = [];
const adminToken = randomBytes(24).toString("hex");
const bridge = await createBridge({
  adminToken,
  portStart: 0,
  portEnd: 0,
  saveDirectory: saveSync ? resolve(work, "save-outbox") : null,
  logger(event) {
    events.push(event);
    if (event.event === "native-error") errors.push(event.reason);
  },
});
const base = `http://127.0.0.1:${bridge.address.port}`;
let room,
  metadata,
  closing = false,
  inputTimer;
const input = createSocket("udp4");
await new Promise((done) => input.bind(0, "127.0.0.1", done));
const proxySockets = new Set();
const proxyTimers = new Set();
const proxy = createTcpServer((client) => {
  const upstream = connect({ host: "127.0.0.1", port: room.tcpPort });
  for (const socket of [client, upstream]) {
    proxySockets.add(socket);
    socket.setNoDelay(true);
    socket.on("error", () => {});
    socket.on("close", () => {
      proxySockets.delete(socket);
      client.destroy();
      upstream.destroy();
    });
  }
  for (const [source, target] of [
    [client, upstream],
    [upstream, client],
  ])
    source.on("data", (bytes) => {
      const timer = setTimeout(() => {
        proxyTimers.delete(timer);
        if (!target.destroyed) target.write(bytes);
      }, latencyMs);
      proxyTimers.add(timer);
    });
});
await new Promise((done) => proxy.listen(0, "127.0.0.1", done));
const baseConfig = await readFile(
  resolve(work, "runtime/retroarch.cfg"),
  "utf8",
);
const assets = createServer((req, res) => {
  const match = /^\/p([01])\/(core|info|rom[01])$/.exec(req.url);
  if (!match) return res.writeHead(404).end();
  const [, p, name] = match;
  if (
    name.startsWith("rom") &&
    req.headers["x-netplay-launch"] !== manifests[p]?.credential
  )
    return res.writeHead(403).end();
  const bytes =
    name === "core" ? dll : name === "info" ? info : roms[Number(name.at(-1))];
  downloads.push(req.url);
  res.writeHead(200, { "Content-Length": bytes.length });
  res.end(bytes);
});
await new Promise((done) => assets.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${assets.address().port}`;
async function api(path, data) {
  const response = await fetch(base + "/v1/rooms" + path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  assert(response.ok, JSON.stringify(result));
  return result;
}
async function until(test, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!(await test())) {
    assert.equal(errors.length, 0, `${label}: ${errors.join("; ")}`);
    assert(Date.now() < end, `Timed out: ${label}`);
    await delay(25);
  }
}
const owner = (player) => `native-test-${player}`;
async function controller(path, player) {
  const socket = new WebSocket(
    base.replace("http:", "ws:") + path + "&retainRoom=1&manualJoin=1",
  );
  sockets.push(socket);
  socket.on("message", (bytes, binary) => {
    if (binary) return;
    const data = JSON.parse(bytes.toString());
    if (data.t === "ping")
      socket.send(JSON.stringify({ t: "pong", nonce: data.nonce }));
  });
  socket.on("error", (e) => {
    if (!closing) errors.push(e.message);
  });
  await until(() => room.peers.get(player)?.kind === "web", "room controller");
}
async function launch(player) {
  const reservation = createSocket("udp4");
  await new Promise((done) => reservation.bind(0, "127.0.0.1", done));
  const remotePort = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  await writeFile(
    resolve(work, "runtime/retroarch.cfg"),
    baseConfig +
      `\nnetwork_remote_enable = "true"\nnetwork_remote_enable_user_p1 = "true"\nnetwork_remote_base_port = "${remotePort}"\n`,
  );
  const prepared = await api(`/${metadata.id}/native`, {
    owner: owner(player),
    romId: cartridgeFor(player).romId,
    cartridge: cartridgeFor(player),
    clientPlatform: "windows-x86_64",
    nickname: `Native test P${player + 1}`,
    saveAllowed: saveSync,
  });
  const root = resolve(output, `p${player}`);
  await mkdir(root, { recursive: true });
  const session = {
    schemaVersion: 1,
    roomId: metadata.id,
    origin,
    expiresAt: prepared.expiresAt,
    credential: prepared.credential,
    platform: "windows-x86_64",
    core: {
      name: dllName,
      url: `${origin}/p${player}/core`,
      sha256: hash(dll),
    },
    coreInfo: info
      ? {
          name: infoName,
          url: `${origin}/p${player}/info`,
          sha256: hash(info),
        }
      : null,
    profile: {
      id: coreId,
      version: profile.coreVersion,
      subsystem: profile.subsystem,
      options: profile.options,
    },
    cartridges: cartridges.map((rom, p) => ({
      ...rom,
      name: `player-${p + 1}.${profile.extension}`,
      url: `${origin}/p${player}/rom${p}`,
    })),
    connection: {
      host: "127.0.0.1",
      port: proxy.address().port,
      password: prepared.nativePassword,
      nickname: `Native test P${player + 1}`,
    },
  };
  manifests[player] = session;
  const manifest = resolve(root, "session.json");
  await writeFile(manifest, JSON.stringify(session));
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    resolve(work, "repo/client/windows-session.ps1"),
    "-Manifest",
    manifest,
    "-RetroArch",
    resolve(work, "runtime/retroarch.exe"),
    "-SessionRoot",
    root,
  ];
  const child = spawn("powershell.exe", args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = { child, root, args, remotePort, stdout: "", stderr: "" };
  children.push(record);
  child.stdout.on("data", (data) => {
    record.stdout += data;
  });
  child.stderr.on("data", (data) => {
    record.stderr += data;
  });
  child.on("error", (error) => errors.push(error.message));
  child.on("exit", (code) => {
    if (!closing)
      errors.push(`P${player + 1} launcher exited: ${code}; ${record.stderr}`);
  });
  await until(
    () =>
      room.peers.get(player)?.kind === "native" && room.peers.get(player).ready,
    "Native RetroArch ready",
  );
  const folders = await readdir(resolve(root, "sessions"));
  assert.equal(folders.length, 1);
  record.directory = resolve(root, "sessions", folders[0]);
  for (const asset of [session.core, session.coreInfo].filter(Boolean))
    assert.equal(
      hash(await readFile(resolve(record.directory, "cores", asset.name))),
      asset.sha256,
    );
  const config = await readFile(
    resolve(record.directory, "retroarch.cfg"),
    "utf8",
  );
  const infoDirectory = /^libretro_info_path = "([^"]+)"/m.exec(config)?.[1];
  assert.equal(
    infoDirectory,
    resolve(record.directory, "cores").replaceAll("\\", "/"),
  );
  assert(!config.includes(session.connection.password));
  return record;
}
try {
  metadata = await api("", {
    system: profile.system,
    coreName: profile.coreName,
    coreVersion: profile.coreVersion,
    saveSize: profile.saveSize,
    players: 2,
    stateSize: 1,
    romId: 11,
    owner: owner(0),
    saveAllowed: saveSync,
    contentCrc: cartridges[0].crc32,
    nativeAllowed: true,
    nativeAuth: true,
    nativeAuthority: true,
    maxPrediction: 12,
    manualStart: true,
    password: "",
    cartridges,
  });
  room = bridge.rooms.get(metadata.id);
  if (startupHeartbeat) {
    const finishStart = room.finishStart.bind(room);
    room.finishStart = () => {
      for (const peer of room.peers.values())
        if (peer.kind === "native") peer.keepLobbyAlive();
      return finishStart();
    };
  }
  // Linux directory fsync is covered by unit tests; Windows cannot fsync a
  // directory. Keep the real queue and SRAM extraction in this transport test.
  if (saveSync)
    room.bridge.saves.write = (entry) =>
      writeFile(
        resolve(work, "save-outbox", entry.id + ".json"),
        JSON.stringify(entry),
      );
  await controller(metadata.hostPath, 0);
  const joined = await api(`/${metadata.id}/join`, {
    owner: owner(1),
    romId: cartridgeFor(1).romId,
    cartridge: cartridgeFor(1),
    saveAllowed: saveSync,
  });
  await controller(joined.peerPath, 1);
  for (const player of [0, 1])
    await api(`/${metadata.id}/control`, {
      owner: owner(player),
      t: "assign",
      player,
      seat: player,
    });
  await launch(0);
  await launch(1);
  assert.equal(room.metadata().current, 2);
  await api(`/${metadata.id}/control`, { owner: owner(0), t: "start-request" });
  await until(() => room.running, "host start");
  const receivedInputs = [0, 0];
  const relayInput = room.relayInput.bind(room);
  room.relayInput = (peer, frame, buttons) => {
    if (buttons) receivedInputs[peer.player]++;
    relayInput(peer, frame, buttons);
  };
  if (saveSync) {
    let tick = 0;
    inputTimer = setInterval(() => {
      for (const [player, record] of children.entries()) {
        for (const button of [3, 8, 5, 7]) {
          const bytes = Buffer.alloc(20);
          bytes.writeInt32LE(1, 4);
          bytes.writeInt32LE(button, 12);
          bytes.writeUInt16LE(
            (tick + player) % 4 === [3, 8, 5, 7].indexOf(button) ? 1 : 0,
            16,
          );
          input.send(bytes, record.remotePort, "127.0.0.1");
        }
      }
      tick++;
    }, 120);
  }
  if (checkpointLag) {
    await until(() => room.progress >= 300, "native snapshot lag setup");
    const target = room.peers.get(1 - room.host);
    target.send(CMD.STALL, words(45));
    await delay(150);
    room.peers.get(room.host).requestCheckpoint();
  }
  await until(() => room.progress >= 1050, "active native input", 23000);
  clearInterval(inputTimer);
  for (const record of children) {
    for (const button of [3, 8, 5, 7]) {
      const bytes = Buffer.alloc(20);
      bytes.writeInt32LE(1, 4);
      bytes.writeInt32LE(button, 12);
      input.send(bytes, record.remotePort, "127.0.0.1");
    }
  }
  await until(
    () => room.progress >= 1300,
    "1200 frames with native snapshot synchronization",
    25000,
  );
  // Once neutral input has settled, a source snapshot is no longer speculative.
  // Verify the other client's independently advanced state before any state
  // reload. This detects divergence hidden by simply suppressing CRC failures.
  const authority = room.peers.get(room.host),
    other = room.peers.get(1 - room.host);
  const nativeCheckpoint = room.nativeCheckpoint.bind(room);
  let verifiedFrame = null;
  room.nativeCheckpoint = (peer, frame, state, generation) => {
    const accepted = nativeCheckpoint(peer, frame, state, generation);
    if (accepted && peer === authority) {
      verifiedFrame = frame;
      other.sendCrc(frame, crc32(state));
    }
    return accepted;
  };
  const saveHost = room.saveHost;
  room.saveHost = () => 0;
  authority.requestCheckpoint();
  room.saveHost = saveHost;
  await until(
    () => verifiedFrame !== null && room.progress > verifiedFrame + 120,
    "independent settled-state CRC",
  );
  assert(other.checksSent > 0);
  assert.equal(errors.length, 0);
  for (const [player, record] of children.entries()) {
    if (coreId !== "snes9x")
      assert.equal(
        (
          await readFile(resolve(record.directory, "player-view.txt"), "utf8")
        ).trim(),
        String(player + 1),
      );
    const log = await readFile(
      resolve(record.directory, "retroarch.log"),
      "utf8",
    );
    assert(
      !/does not support netplay|state mismatch|Failed to initialize netplay/i.test(
        log,
      ),
      `RetroArch P${player + 1} rejected netplay`,
    );
    assert(log.includes(dllName), "RetroArch did not load the prepared core");
    for (const name of [
      "core",
      ...(info ? ["info"] : []),
      ...roms.map((_, p) => `rom${p}`),
    ])
      assert.equal(
        downloads.filter((url) => url === `/p${player}/${name}`).length,
        1,
      );
  }
  assert(room.peers.get(1).statesRelayed >= 2, "No native snapshots relayed");
  const inputRebases = events.filter(
    (event) => event.event === "native-input-rebased",
  ).length;
  if (checkpointLag)
    assert(inputRebases > 0, "No future-state input jump exercised");
  assert.equal(room.resyncs.length, 0);
  if (saveSync) {
    assert.equal(room.saveStatus().error, null);
    assert.equal(room.bridge.saves.list(room.id).length, 2);
    assert(receivedInputs.every((count) => count > 100));
  }
  const result = {
    retroarch: "Windows 1.22.2",
    core: coreId,
    frames: room.progress,
    automaticCoreAndInfoDownloads: true,
    players: 2,
    nativeSnapshots: room.peers.get(1).statesRelayed,
    assignedViews: coreId === "snes9x" ? null : [1, 2],
    resyncs: 0,
    errors,
    saveSync,
    latencyMs,
    checkpointLag,
    startupHeartbeat,
    inputRebases,
    receivedInputs,
    verifiedFrame,
    independentCrcChecks: other.checksSent,
    memoryLimitMiB: 1536,
    cpus: 2,
    timeoutSeconds: 60,
  };
  await writeFile(
    resolve(output, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  closing = true;
  clearInterval(inputTimer);
  input.close();
  for (const record of children) {
    await writeFile(resolve(record.root, "launcher.stdout.log"), record.stdout);
    await writeFile(resolve(record.root, "launcher.stderr.log"), record.stderr);
    if (record.child.exitCode === null) {
      await new Promise((done) => {
        const stop = spawn(
          "taskkill.exe",
          ["/PID", String(record.child.pid), "/T", "/F"],
          { stdio: "ignore", windowsHide: true },
        );
        stop.on("error", done);
        stop.on("exit", done);
      });
    }
  }
  for (const socket of sockets) socket.close();
  await bridge.close();
  for (const timer of proxyTimers) clearTimeout(timer);
  for (const socket of proxySockets) socket.destroy();
  await new Promise((done) => proxy.close(done));
  assets.closeAllConnections();
  await new Promise((done) => assets.close(done));
  await writeFile(
    resolve(output, "events.json"),
    JSON.stringify(events, null, 2),
  );
}
