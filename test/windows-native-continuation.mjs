import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, copyFile, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { createBridge } from "../server.mjs";
import { crc32, CMD, words } from "../wire.mjs";
import { linkCore } from "../client/link-core.js";
import { BridgeConnection } from "../client/bridge-session.js";
import { browserPeer } from "./windows-browser-peer.mjs";

assert.equal(process.platform, "win32", "Use the bounded Windows runner");
const work = resolve(process.argv[2]);
const scenario = process.argv[3] ?? "fresh";
const pacing = scenario === "pacing";
const diagnostic = process.argv.includes("--diagnostic");
const commercial = process.argv.includes("--commercial");
assert(!commercial || scenario === "cable-browser");
assert(
  ["fresh", "rejoin", "handoff", "web-host", "cable-browser", "pacing"].includes(
    scenario,
  ),
);
const label = process.argv.find((arg) => arg.startsWith("--label="))?.slice(8);
assert(!label || /^[a-z0-9-]+$/.test(label));
const output = resolve(
  work,
  label ?? scenario + (diagnostic ? "-diagnostic" : ""),
);
await mkdir(output, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function telemetry(state) {
  const players = state.readUInt32LE(8);
  assert.equal(state.readUInt32LE(0), 0x54535053);
  assert([4, 5].includes(state.readUInt32LE(4)));
  const stride = 64 + 131072;
  const base = state.length - 8 - players * stride + 8;
  return Array.from({ length: players }, (_, p) => {
    const start = base + p * stride;
    const sram = start + 64;
    if (commercial) return { framesProduced: state.readUInt32LE(start + 8) };
    return {
      framesProduced: state.readUInt32LE(start + 8),
      frame: state.readUInt32LE(sram + 16),
      received: state.readUInt32LE(sram + 20),
      saves: state.readUInt32LE(sram + 4),
      keys: state.readUInt32LE(sram + 24),
    };
  });
}
const roms = await Promise.all(
  [1, 2].map((n) => readFile(resolve(work, `player-${n}.gba`))),
);
const cartridges = roms.map((bytes, p) => ({
  romId: p + 11,
  size: bytes.length,
  crc32: crc32(bytes),
  sha256: hash(bytes),
}));
const adminToken = randomBytes(24).toString("hex");
const events = [],
  errors = [],
  children = [],
  sockets = [],
  logs = [];
const evidence = {
  scenario,
  commercialContent: commercial,
  cartridgeHashes: cartridges.map((item) => item.sha256),
  emulators: "Windows RetroArch",
  memoryLimitMiB: 1536,
  cpuAffinity: 3,
  timeoutSeconds: 60,
};
let expectedClose = null;
const bridge = await createBridge({
  adminToken,
  portStart: 0,
  portEnd: 0,
  logger: (event) => {
    events.push(event);
    if (event.event === "native-error") {
      if (
        event.player === expectedClose &&
        (event.code === "ECONNRESET" || event.reason === "Left the room")
      )
        evidence.expectedCloseObserved = true;
      else errors.push(event.reason);
    }
  },
});
const base = `http://127.0.0.1:${bridge.address.port}`;
let room,
  info,
  closing = false,
  diagnosticTimer,
  webConnection,
  webTimer,
  webAdapter;
async function api(path, data) {
  const response = await fetch(base + "/v1/rooms" + path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
  const value = await response.json();
  assert(response.ok, JSON.stringify(value));
  return value;
}
async function until(predicate, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    assert.equal(errors.length, 0, `${label}: ${errors.join("; ")}`);
    assert(!room?.closed, `Room closed during ${label}`);
    assert(Date.now() < end, `Timed out: ${label}`);
    await delay(20);
  }
}
async function controller(path, player, adapter = null) {
  if (adapter?.browser) {
    const url = base.replace("http:", "ws:") + path + "&retainRoom=1";
    await adapter.evaluate(
      `window.connectPeer(${JSON.stringify(url)}, ${player})`,
    );
    await until(
      () => room.peers.get(player)?.kind === "web",
      "browser connected",
    );
    return;
  }
  const socket = new WebSocket(
    base.replace("http:", "ws:") +
      path +
      "&retainRoom=1" +
      (adapter ? "" : "&manualJoin=1"),
  );
  sockets.push(socket);
  if (adapter) {
    webConnection = new BridgeConnection(adapter, socket, {
      player,
      players: 2,
      maxPrediction: 12,
      onError: (error) => errors.push(error.message),
      onActionError: (message) => errors.push(message),
    });
    webTimer = setInterval(() => {
      if (
        !webConnection.started ||
        webConnection.session.frame > room.progress + 4
      )
        return;
      webConnection.tick(webConnection.session.frame % 90 < 12 ? 256 : 0);
    }, 16);
  } else
    socket.on("message", (bytes, binary) => {
      if (binary) return;
      const data = JSON.parse(bytes.toString());
      if (data.t === "ping")
        socket.send(JSON.stringify({ t: "pong", nonce: data.nonce }));
    });
  socket.on("error", (error) => {
    if (!closing) errors.push(error.message);
  });
  await until(
    () => room.peers.get(player)?.kind === "web",
    "controller connected",
  );
}
async function loadWebAdapter() {
  const { default: init } = await import(
    pathToFileURL(resolve(work, "web-build/core-probe.mjs"))
  );
  const core = await init({ print() {}, printErr() {} });
  const pointers = roms.map((rom) => {
    const pointer = core._malloc(rom.length);
    core.HEAPU8.set(rom, pointer);
    return pointer;
  });
  assert(
    core._probe_init_pair(
      pointers[0],
      roms[0].length,
      pointers[1],
      roms[1].length,
    ),
  );
  core._probe_step(0, 0, 0, 0);
  const size = core._probe_size(),
    pointer = core._malloc(size);
  return {
    size,
    profile: linkCore("mgba_splitscreen", 2),
    memory(id) {
      const p = core._probe_memory(id);
      return core.HEAPU8.slice(p, p + core._probe_memory_size(id));
    },
    loadMemory(id, bytes) {
      core.HEAPU8.set(bytes, core._probe_memory(id));
    },
    save() {
      assert(core._probe_save(pointer, size));
      return core.HEAPU8.slice(pointer, pointer + size);
    },
    load(bytes) {
      core.HEAPU8.set(bytes, pointer);
      assert(core._probe_load(pointer, size));
    },
    stepPlayers(buttons) {
      core._probe_step(buttons[0] ?? 0, buttons[1] ?? 0, 0, 0);
    },
    close() {
      core._probe_close();
      core._free(pointer);
      for (const p of pointers) core._free(p);
    },
  };
}
const owner = (player) => `test-owner-${player}`;
function control(player, data) {
  if (data.t === "start-request")
    evidence.hostStartRequests = (evidence.hostStartRequests ?? 0) + 1;
  return api(`/${info.id}/control`, { owner: owner(player), ...data });
}
async function launch(player, attempt) {
  const prepared = await api(`/${info.id}/native`, {
    owner: owner(player),
    romId: player + 11,
    cartridge: cartridges[player],
    clientPlatform: "windows-x86_64",
    nickname: `Test P${player + 1}`,
  });
  const folder = resolve(output, `p${player}-${attempt}`);
  await mkdir(resolve(folder, "saves/.netplay"), { recursive: true });
  const tunnel = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(work, "repo/test/windows-continuation-tunnel.ps1"),
      "-Launcher",
      resolve(work, "repo/client/windows-session.ps1"),
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  children.push(tunnel);
  tunnel.on("error", (error) => errors.push(error.message));
  let tunnelOutput = "",
    tunnelErrors = "";
  tunnel.stdout.on("data", (bytes) => {
    tunnelOutput += bytes;
  });
  tunnel.stderr.on("data", (bytes) => {
    tunnelErrors += bytes;
  });
  tunnel.stdin.write(
    JSON.stringify({
      host: "127.0.0.1",
      port: room.tcpPort,
      password: prepared.nativePassword,
    }) + "\n",
  );
  await until(
    () => tunnelOutput.includes("\n") || tunnel.exitCode !== null,
    "launcher authentication tunnel",
  );
  const tunnelPort = Number(tunnelOutput.trim());
  assert(
    tunnelPort > 0 && tunnelPort <= 65535,
    `Launcher tunnel failed: ${tunnelErrors}`,
  );
  for (let p = 0; p < 2; p++) {
    await copyFile(
      resolve(work, `player-${p + 1}.gba`),
      resolve(folder, `player-${p + 1}.gba`),
    );
    if (!commercial) {
      const seed = Buffer.alloc(131072, 0xff);
      seed.fill(0xa9 + p, seed.length - 64);
      await writeFile(
        resolve(folder, `saves/.netplay/player-${p + 1}.sav${p ? "2" : ""}`),
        seed,
      );
    }
  }
  await writeFile(
    resolve(folder, "options.cfg"),
    Object.entries(linkCore("mgba_splitscreen").options)
      .map(([key, value]) => `${key} = "${value}"`)
      .join("\n") + "\n",
  );
  const config = {
    config_save_on_exit: "false",
    video_driver: "gl",
    video_fullscreen: "false",
    video_window_scale: "1",
    audio_driver: "null",
    audio_enable: "false",
    video_vsync: "false",
    vrr_runloop_enable: "true",
    fastforward_ratio: "1.0",
    pause_nonactive: "false",
    menu_pause_libretro: "false",
    savestate_auto_load: "false",
    savestate_auto_save: "false",
    rewind_enable: "false",
    run_ahead_enabled: "false",
    preemptive_frames_enable: "false",
    auto_overrides_enable: "false",
    game_specific_options: "false",
    savefile_directory: resolve(folder, "saves"),
    savestate_directory: resolve(folder, "saves"),
    core_options_path: resolve(folder, "options.cfg"),
    system_directory: folder,
    sort_savefiles_enable: "false",
    sort_savefiles_by_content_enable: "false",
    savefiles_in_content_dir: "false",
    netplay_start_as_spectator: "false",
    netplay_password: "",
    libretro_log_level: "2",
  };
  if (pacing)
    Object.assign(config, {
      video_driver: "d3d11",
      video_vsync: "true",
      video_threaded: "false",
      audio_driver: "wasapi",
      audio_enable: "true",
      audio_sync: "true",
      audio_volume: "-80",
      libretro_info_path: work,
      input_auto_game_focus: "0",
    });
  const reservation = createSocket("udp4");
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.bind(0, "127.0.0.1", resolve);
  });
  const remotePort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  Object.assign(config, {
    network_remote_enable: "true",
    network_remote_enable_user_p1: "true",
    network_remote_base_port: remotePort,
  });
  await writeFile(
    resolve(folder, "retroarch.cfg"),
    Object.entries(config)
      .map(
        ([key, value]) => `${key} = "${String(value).replaceAll("\\", "/")}"`,
      )
      .join("\n") + "\n",
  );
  const log = await open(resolve(folder, "retroarch.log"), "w");
  logs.push(log);
  const child = spawn(
    resolve(work, "runtime/retroarch.exe"),
    [
      "--verbose",
      "--config",
      resolve(folder, "retroarch.cfg"),
      "-L",
      resolve(work, "core.dll"),
      "--connect",
      "127.0.0.1",
      "--port",
      String(tunnelPort),
      "--nick",
      `Test P${player + 1}`,
      "--check-frames=60",
      "--subsystem",
      "gba_link_2p",
      resolve(folder, "player-1.gba"),
      resolve(folder, "player-2.gba"),
    ],
    { cwd: folder, stdio: ["ignore", log.fd, log.fd], windowsHide: true },
  );
  children.push(child);
  child.on("error", (error) => errors.push(error.message));
  await until(
    () =>
      room.peers.get(player)?.kind === "native" &&
      room.peers.get(player)?.ready,
    `native ${player} ready`,
  );
  const peer = room.peers.get(player);
  const sendState = peer.sendState.bind(peer);
  peer.sendState = (frame, state) => {
    (evidence.transfers ??= []).push({
      player,
      attempt,
      frame,
      bytes: state.length,
      sha256: hash(state),
      generation: room.generation,
    });
    return sendState(frame, state);
  };
  return { child, peer, remotePort };
}
async function pressA(client) {
  const remote = createSocket("udp4");
  try {
    for (const pressed of [1, 0]) {
      const bytes = Buffer.alloc(20);
      bytes.writeInt32LE(1, 4);
      bytes.writeInt32LE(8, 12);
      bytes.writeUInt16LE(pressed, 16);
      await new Promise((resolve, reject) =>
        remote.send(bytes, client.remotePort, "127.0.0.1", (error) =>
          error ? reject(error) : resolve(),
        ),
      );
      await delay(150);
    }
  } finally {
    remote.close();
  }
}
try {
  if (scenario === "cable-browser")
    webAdapter = await browserPeer(work, errors);
  if (["handoff", "web-host"].includes(scenario))
    webAdapter = await loadWebAdapter();
  info = await api("", {
    system: "gba",
    coreName: "mGBA Splitscreen",
    coreVersion:
      scenario === "cable-browser" || pacing
        ? "0.1.0-f1d5975-cable1"
        : "0.1.0-f1d5975-rollback2",
    players: 2,
    stateSize: webAdapter?.size ?? 1,
    contentCrc: cartridges[0].crc32,
    romId: 11,
    owner: owner(0),
    nativeAllowed: true,
    nativeAuth: true,
    nativeAuthority: true,
    maxPrediction: 12,
    manualStart: true,
    password: "",
    cartridges,
  });
  room = bridge.rooms.get(info.id);
  const nativeCheckpoint = room.nativeCheckpoint.bind(room);
  room.nativeCheckpoint = (peer, frame, state, generation) => {
    (evidence.checkpoints ??= []).push({
      player: peer.player,
      frame,
      bytes: state.length,
      crc: crc32(state),
      generation: room.generation,
      telemetry: telemetry(state),
      cableMask: state.readUInt32LE(state.length - 8 - 2 * (64 + 131072)),
    });
    if (diagnostic && frame < 600) return;
    return nativeCheckpoint(peer, frame, state, generation);
  };
  const checksum = room.checksum.bind(room);
  room.checksum = (peer, data) => {
    if (scenario === "web-host" && data.f % 600 === 0) {
      const state = Buffer.from(webConnection.session.stateAt(data.f));
      (evidence.checkpoints ??= []).push({
        player: peer.player,
        frame: data.f,
        crc: data.crc,
        generation: room.generation,
        telemetry: telemetry(state),
      });
    }
    return checksum(peer, data);
  };
  await controller(info.hostPath, 0);
  const joined = await api(`/${info.id}/join`, {
    owner: owner(1),
    romId: 12,
    cartridge: cartridges[1],
  });
  let host = webAdapter ? await launch(0, 0) : null;
  await controller(joined.peerPath, 1, webAdapter);
  for (const player of [0, 1])
    await control(player, { t: "assign", player, seat: player });
  host ??= await launch(0, 0);
  let guest = webAdapter ? null : await launch(1, 0);
  await control(0, { t: "start-request" });
  await until(() => room.running, "initial start");
  evidence.initialStateHash = hash(room.state);
  evidence.initialTelemetry = telemetry(room.state);
  evidence.initialBatteryMarkers = [0xa9, 0xaa].map((value) =>
    room.state.includes(Buffer.alloc(64, value)),
  );
  assert(
    commercial || evidence.initialBatteryMarkers.every(Boolean),
    "Initial battery seeds were not imported",
  );
  await until(() => room.progress >= 60, "fixture startup");
  await pressA(host);
  if (guest) await pressA(guest);
  if (!["fresh", "cable-browser", "pacing"].includes(scenario)) {
    await until(() => room.progress >= 180, "progress before rejoin");
    evidence.progressBeforeClose = room.progress;
    if (webAdapter) {
      evidence.webStats = { ...webConnection.session.stats };
      assert(
        evidence.webStats.checks >= 2,
        "Mixed gameplay did not verify its state",
      );
    }
    const returningPlayer = scenario === "web-host" ? 0 : 1;
    const retainedPeer = room.peers.get(1 - returningPlayer);
    if (scenario === "handoff") {
      clearInterval(webTimer);
      webConnection.closeGame();
      await until(() => room.peers.get(1)?.gameClosed, "web returns to room");
    } else {
      expectedClose = returningPlayer;
      (returningPlayer === 0 ? host : guest).child.kill();
      await until(
        () => room.peers.get(returningPlayer)?.kind === "web",
        "room membership retained",
      );
    }
    await until(
      () => room.progress > evidence.progressBeforeClose + 30,
      "host continues alone",
    );
    evidence.progressBeforeRestart = room.progress;
    const generation = room.generation;
    guest = await launch(returningPlayer, 1);
    expectedClose = null;
    await until(
      () => room.running && room.generation > generation,
      "restart from live state",
    );
    evidence.resumedStateHash = hash(room.state);
    evidence.resumedTelemetry = telemetry(room.state);
    evidence.resumedBatteryMarkers = [0xa9, 0xaa].map((value) =>
      room.state.includes(Buffer.alloc(64, value)),
    );
    assert(evidence.resumedBatteryMarkers.every(Boolean));
    assert.notEqual(
      evidence.resumedStateHash,
      evidence.initialStateHash,
      "Restart returned to the initial state",
    );
    assert(
      evidence.resumedTelemetry.every(
        (item) => item.frame > 100 && item.saves >= 1,
      ),
      "In-game progress or input-written saves were lost",
    );
    const transfers = evidence.transfers.filter(
      (item) => item.generation === room.generation,
    );
    assert.equal(transfers.length, scenario === "web-host" ? 1 : 2);
    assert(
      transfers.every((item) => item.sha256 === evidence.resumedStateHash),
    );
    evidence.sourceConnectionRetained =
      room.peers.get(1 - returningPlayer) === retainedPeer;
    assert(evidence.sourceConnectionRetained);
    await until(() => room.progress >= 60, "resumed input ready");
    await pressA(guest);
    if (diagnostic)
      diagnosticTimer = setInterval(() => {
        if (room.progress < 120) return;
        clearInterval(diagnosticTimer);
        host.peer.requestCheckpoint();
        guest.peer.requestCheckpoint();
      }, 10);
  }
  if (pacing) {
    const sample = () => ({
      host: host.peer.nextFrame,
      guest: guest.peer.nextFrame,
      lead: guest.peer.nextFrame - host.peer.nextFrame,
    });
    await until(() => room.progress >= 120, "pacing startup");
    const methods = [host, guest].map((client) => client.peer.pace);
    for (const client of [host, guest]) client.peer.pace = () => {};
    evidence.beforeStall = sample();
    guest.peer.send(CMD.STALL, words(8));
    await delay(300);
    evidence.afterStall = sample();
    assert(
      evidence.beforeStall.lead - evidence.afterStall.lead >= 5,
      "The requested eight-frame stall consumed insufficient wall time",
    );
    [host, guest].forEach((client, i) => (client.peer.pace = methods[i]));
    await until(
      () => Math.abs(sample().lead) <= 3,
      "host yields to the slower native participant",
      7000,
    );
    evidence.behindRecovered = sample();
    // Let the accepted stall finish before injecting another one; RetroArch
    // ignores a second STALL while the first is still in progress.
    await delay(700);
    host.peer.send(CMD.STALL, words(12));
    await delay(450);
    evidence.guestAhead = sample();
    assert(evidence.guestAhead.lead >= 6);
    await until(
      () => Math.abs(sample().lead) <= 3,
      "guest yields to the slower native host",
      7000,
    );
    evidence.aheadRecovered = sample();
    evidence.pacedPlayers = [
      ...new Set(events.filter((e) => e.event === "native-paced").map((e) => e.player)),
    ].sort();
    assert.deepEqual(evidence.pacedPlayers, [0, 1]);
    assert.equal(room.host, 0);
    evidence.finalProgress = room.progress;
    evidence.passed = true;
  } else if (scenario === "cable-browser") {
    const snapshot = async () => {
      const value = await webAdapter.evaluate("window.peerSnapshot()");
      assert.deepEqual(value.errors, []);
      return { ...value, state: Buffer.from(value.state, "base64") };
    };
    const checkpoint = async () => {
      const count = evidence.checkpoints?.length ?? 0;
      host.peer.requestCheckpoint();
      await until(
        () => (evidence.checkpoints?.length ?? 0) > count,
        "native cable checkpoint",
      );
      return evidence.checkpoints.at(-1);
    };
    await until(
      () => room.progress >= 650,
      "initial browser/native CRC",
      18000,
    );
    evidence.browserInitial = await snapshot();
    delete evidence.browserInitial.state;
    assert(evidence.browserInitial.stats.checks >= 5);
    await webAdapter.evaluate("window.peer.closeGame()");
    await until(() => room.peers.get(1)?.gameClosed, "browser returns to room");
    let frame = room.progress;
    await until(
      () => room.progress > frame + 90,
      "native continues with retained room",
    );
    evidence.retained = await checkpoint();
    assert.equal(evidence.retained.cableMask, 3);
    await webAdapter.evaluate("window.peer.stop()");
    await until(() => !room.peers.has(1), "browser leaves room");
    frame = room.progress;
    await until(
      () => room.progress > frame + 120,
      "native continues with cable detached",
    );
    evidence.detached = await checkpoint();
    assert.equal(evidence.detached.cableMask, 1);
    assert(
      evidence.detached.telemetry.every(
        (p, i) =>
          p.framesProduced > evidence.retained.telemetry[i].framesProduced,
      ),
    );
    const rejoined = await api(`/${info.id}/join`, {
      owner: owner(1),
      romId: 12,
      cartridge: cartridges[1],
    });
    await controller(rejoined.peerPath, 1, webAdapter);
    await control(1, { t: "assign", player: 1, seat: 1 });
    await webAdapter.evaluate("window.peer.openGame()");
    await until(() => room.peers.get(1)?.playing, "browser rejoins live state");
    frame = room.progress;
    await until(
      () => room.progress > frame + 650,
      "CRC after cable reconnect",
      18000,
    );
    evidence.reconnected = await checkpoint();
    assert.equal(evidence.reconnected.cableMask, 3);
    const browser = await snapshot();
    evidence.browserRejoined = {
      frame: browser.frame,
      confirmed: browser.confirmed,
      stats: browser.stats,
    };
    assert(browser.stats.checks >= 5);
    expectedClose = 0;
    await api(`/${info.id}/leave`, { owner: owner(0) });
    await until(
      () => !room.peers.has(0) && room.host === 1,
      "native host leaves room",
    );
    frame = room.progress;
    await until(
      () => room.progress > frame + 90,
      "browser continues without native host",
    );
    const remaining = await snapshot();
    const mask = remaining.state.readUInt32LE(
      remaining.state.length - 8 - 2 * (64 + 131072),
    );
    assert.equal(mask, 2);
    evidence.remainingBrowser = {
      frame: remaining.frame,
      cableMask: mask,
      telemetry: telemetry(remaining.state),
    };
    assert.equal(evidence.hostStartRequests, 1);
    evidence.passed = true;
  } else {
    await until(
      () =>
        room.progress >= 1250 &&
        guest.peer.checksSent + guest.peer.statesRelayed >= 2,
      "two native state synchronizations",
      26000,
    );
    assert.equal(errors.length, 0);
    const finalCheckpoint = evidence.checkpoints.at(-1);
    assert(finalCheckpoint.telemetry.every((item) => item.saves >= 1));
    if (scenario !== "fresh")
      assert(
        finalCheckpoint.telemetry[scenario === "web-host" ? 0 : 1].saves >
          evidence.resumedTelemetry[scenario === "web-host" ? 0 : 1].saves,
        "Resumed native input was not applied",
      );
    evidence.passed = true;
    assert.equal(
      evidence.hostStartRequests,
      1,
      "Rejoining required another host start command",
    );
    evidence.finalProgress = room.progress;
    evidence.checksDelivered = guest.peer.checksSent;
    evidence.snapshotsRelayed = guest.peer.statesRelayed;
  }
} catch (error) {
  evidence.passed = false;
  evidence.error = error.message;
  process.exitCode = 1;
} finally {
  closing = true;
  clearInterval(diagnosticTimer);
  clearInterval(webTimer);
  webConnection?.stop();
  await webAdapter?.close();
  evidence.errors = errors;
  evidence.finalPeers = [...(room?.peers.values() ?? [])].map((peer) => ({
    player: peer.player,
    kind: peer.kind,
    frame: peer.frame,
    nextFrame: peer.nextFrame,
    offset: peer.frameOffset,
  }));
  for (const socket of sockets) socket.close();
  for (const child of children) if (child.exitCode === null) child.kill();
  await bridge.close();
  await Promise.all(logs.map((log) => log.close()));
  await writeFile(
    resolve(output, "events.json"),
    JSON.stringify(events, null, 2),
  );
  await writeFile(
    resolve(output, "result.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
}
