import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { createBridge } from "../server.mjs";
import { crc32 } from "../wire.mjs";
import { BridgeConnection } from "../client/bridge-session.js";
import { linkCore } from "../client/link-core.js";
if (process.platform !== "win32")
  throw new Error(
    "Run this emulator qualification on Windows using windows-bounded.exe",
  );
const repo = fileURLToPath(new URL("../", import.meta.url));
const work = resolve(process.argv[2]);
const output = resolve(work, "windows-launch");
await mkdir(output, { recursive: true });
const { default: init } = await import(
  pathToFileURL(resolve(work, "web-build/core-probe.mjs"))
);
const core = await init({ print() {}, printErr() {} });
const roms = await Promise.all(
  [1, 2].map((i) => readFile(resolve(repo, `test/fixtures/gba-link-${i}.gba`))),
);
const ptrs = roms.map((rom) => {
  const ptr = core._malloc(rom.length);
  core.HEAPU8.set(rom, ptr);
  return ptr;
});
assert(core._probe_init_pair(ptrs[0], roms[0].length, ptrs[1], roms[1].length));
core._probe_step(0, 0, 0, 0);
const size = core._probe_size(),
  statePtr = core._malloc(size);
const adapter = {
  size,
  profile: linkCore("mgba_splitscreen", 2),
  memory(id) {
    const p = core._probe_memory(id);
    return core.HEAPU8.slice(p, p + core._probe_memory_size(id));
  },
  loadMemory(id, data) {
    core.HEAPU8.set(data, core._probe_memory(id));
  },
  save() {
    assert(core._probe_save(statePtr, size));
    return core.HEAPU8.slice(statePtr, statePtr + size);
  },
  load(data) {
    core.HEAPU8.set(data, statePtr);
    assert(core._probe_load(statePtr, size));
  },
  stepPlayers(buttons) {
    core._probe_step(buttons[0] ?? 0, buttons[1] ?? 0, 0, 0);
  },
};
const sha = (b) => createHash("sha256").update(b).digest("hex");
const descriptors = roms.map((rom, i) => ({
  romId: i + 11,
  size: rom.length,
  sha256: sha(rom),
  crc32: crc32(rom),
}));
const errors = [],
  events = [];
const adminToken = "windows-qualification-private-key";
const bridge = await createBridge({
  adminToken,
  portStart: 0,
  portEnd: 0,
  logger: (event) => events.push(event),
});
const base = `http://127.0.0.1:${bridge.address.port}`;
async function api(path, data, method = "POST") {
  const r = await fetch(base + "/v1/rooms" + path, {
    method,
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const v = await r.json();
  assert(r.ok, JSON.stringify(v));
  return v;
}
let native, connection, guest, ticker, assets;
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!fn()) {
    if (errors.length) throw Error(errors.join("; "));
    if (Date.now() > end) throw Error("Windows qualification timed out");
    await delay(20);
  }
}
try {
  const room = await api("", {
    romId: 11,
    owner: "host",
    password: "",
    system: "gba",
    coreName: "mGBA Splitscreen",
    coreVersion: "0.1.0-f1d5975-rollback2",
    players: 2,
    stateSize: size,
    contentCrc: crc32(roms[0]),
    maxPrediction: 12,
    nativeAllowed: true,
    nativeAuth: true,
    manualStart: true,
    cartridges: descriptors,
  });
  const stored = bridge.rooms.get(room.id);
  connection = new BridgeConnection(
    adapter,
    new WebSocket(base.replace("http:", "ws:") + room.hostPath),
    {
      player: 0,
      players: 2,
      maxPrediction: 12,
      onError: (e) => errors.push(e.message),
      onActionError: (e) => errors.push(e),
    },
  );
  await until(() => stored.state);
  const joined = await api(`/${room.id}/join`, { owner: "guest", romId: 12 });
  guest = new WebSocket(base.replace("http:", "ws:") + joined.peerPath);
  await until(() => stored.peers.size === 2);
  stored.seats = [0, 1];
  const battery = adapter.memory(256);
  battery[battery.length - 1] = 42;
  const prepared = await api(`/${room.id}/native`, {
    owner: "guest",
    romId: 12,
    nickname: "Windows test",
    clientPlatform: "windows-x86_64",
    battery: Buffer.from(battery).toString("base64"),
  });
  assert.equal(prepared.player, joined.player);
  assert.equal(stored.metadata().current, 2);
  const dll = await readFile(
    resolve(
      work,
      "windows/artifacts/mgba_splitscreen/windows-x86_64/mgba_splitscreen_libretro.dll",
    ),
  );
  const zip = await readFile(resolve(work, "fixture-2.zip"));
  assets = createServer((req, res) => {
    if (
      req.url.startsWith("/rom/") &&
      req.headers["x-netplay-launch"] !== prepared.credential
    ) {
      res.writeHead(403).end();
      return;
    }
    const data =
      req.url === "/core"
        ? dll
        : req.url === "/rom/0"
          ? roms[0]
          : req.url === "/rom/1"
            ? zip
            : null;
    if (!data) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Length": data.length });
    res.end(data);
  });
  await new Promise((r) => assets.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${assets.address().port}`;
  const session = {
    schemaVersion: 1,
    roomId: room.id,
    expiresAt: prepared.expiresAt,
    platform: "windows-x86_64",
    credential: prepared.credential,
    origin,
    core: {
      name: "mgba_splitscreen_libretro.dll",
      url: origin + "/core",
      sha256: sha(dll),
    },
    coreInfo: null,
    profile: {
      id: "mgba_splitscreen",
      extension: "gba",
      subsystem: "gba_link_2p",
      options: {
        ...linkCore("mgba_splitscreen").options,
        splitscreen_layout: "auto",
      },
    },
    cartridges: descriptors.map((d, i) => ({
      ...d,
      name: `player-${i + 1}.gba`,
      url: origin + `/rom/${i}`,
    })),
    connection: {
      host: "127.0.0.1",
      port: room.tcpPort,
      password: prepared.nativePassword,
      nickname: "Windows test",
    },
  };
  const manifest = resolve(output, "session.json");
  await writeFile(manifest, JSON.stringify(session));
  const executable = resolve(
    work,
    "retroarch-win/RetroArch-Win64/retroarch.exe",
  );
  const helper = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(repo, "test/windows-launcher.ps1"),
      "-Launcher",
      resolve(repo, "client/windows-session.ps1"),
      "-Manifest",
      manifest,
      "-RetroArch",
      executable,
      "-Root",
      output,
    ],
    { stdio: "inherit" },
  );
  assert.equal((await once(helper, "exit"))[0], 0, "Windows helper failed");
  const launch = JSON.parse(
    (await readFile(resolve(output, "prepared.json"), "utf8")).replace(
      /^\uFEFF/,
      "",
    ),
  );
  // The portable test installation is isolated from the user's RetroArch.
  await writeFile(
    resolve(work, "retroarch-win/RetroArch-Win64/retroarch.cfg"),
    'video_driver = "gl"\naudio_driver = "null"\nlibretro_log_level = "3"\nvideo_window_scale = "1"\n',
  );
  native = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(repo, "client/windows-session.ps1"),
      "-Manifest",
      manifest,
      "-RetroArch",
      executable,
      "-SessionRoot",
      output,
    ],
    { stdio: "inherit" },
  );
  native.on("error", (e) => errors.push(e.message));
  await until(() => stored.peers.get(1)?.ready);
  assert.equal(stored.metadata().current, 2);
  assert.equal(stored.peers.get(1).clientPlatform, "windows-x86_64");
  await delay(10500);
  assert(stored.peers.has(1), "Native lobby disconnected before host start");
  connection.startGame();
  await until(() => connection.started);
  ticker = setInterval(() => {
    const peer = stored.peers.get(1);
    if (!peer) {
      errors.push("Native client disconnected");
      return;
    }
    const nativeFrame = peer.lastReportedFrame - peer.frameOffset;
    if (connection.session.frame <= nativeFrame + 6)
      connection.tick(connection.session.frame % 19 < 5 ? 256 : 0);
  }, 16);
  await until(() => connection.session.confirmed >= 300, 20000);
  clearInterval(ticker);
  const state = connection.session.confirmedMemory(256);
  assert.equal(state[2], 2);
  assert.equal(state[state.length - 1], 42);
  assert.equal(connection.session.confirmedMemory(0)[2], 1);
  const receives = new DataView(
    state.buffer,
    state.byteOffset,
    state.byteLength,
  ).getUint32(20, true);
  assert(receives > 200, "GBA link did not advance");
  assert(
    stored.peers.get(1).checksSent >= 3,
    "No native state checks delivered",
  );
  assert.equal(stored.resyncs.length, 0, "Unexpected resynchronization");
  const summary = {
    confirmed: connection.session.confirmed,
    cartridges: [1, 2],
    receives,
    batteryPreserved: true,
    members: stored.metadata().current,
    clientPlatform: stored.peers.get(1).clientPlatform,
    checks: stored.peers.get(1).checksSent,
    lobbyWaitMs: 10500,
    stats: connection.session.stats,
    errors,
  };
  await writeFile(
    resolve(output, "result.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary));
} catch (error) {
  await writeFile(
    resolve(output, "error.txt"),
    error.stack + "\n" + JSON.stringify(errors),
  );
  throw error;
} finally {
  clearInterval(ticker);
  connection?.stop();
  guest?.close();
  native?.kill();
  await bridge.close();
  if (assets) await new Promise((r) => assets.close(r));
  await writeFile(
    resolve(output, "events.json"),
    JSON.stringify(events, null, 2),
  );
  core._probe_close();
}
