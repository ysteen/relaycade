import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { createBridge } from "../server.mjs";
import { BridgeConnection } from "../client/bridge-session.js";

const cartridge = (romId) => ({
  romId,
  sha256: String(romId).repeat(64),
  size: 32768,
  crc32: romId,
});
const manifest = {
  system: "gba",
  coreName: "mGBA Splitscreen",
  coreVersion: "test",
  romId: 1,
  contentCrc: 1,
  stateSize: 1,
  players: 2,
  nativeAllowed: true,
  nativeAuth: true,
  manualStart: true,
  password: "",
  collectCartridges: true,
  cartridges: [cartridge(1), cartridge(1)],
  owner: "host",
};

class MemoryCore {
  profile = { core: "mgba_splitscreen", memoryIds: [0, 256] };
  size = 1028;
  data = new Uint8Array(this.size);
  save() {
    return this.data.slice();
  }
  load(bytes) {
    this.data.set(bytes);
  }
  memory(id) {
    return this.data.subarray(id === 256 ? 516 : 4, id === 256 ? 1028 : 516);
  }
  loadMemory(id, bytes) {
    this.memory(id).set(bytes);
  }
  stepPlayers() {
    this.data[0]++;
  }
}

async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("Room transition timed out");
}

async function setup(t, overrides = {}) {
  const token = "test-cartridge-collection-token";
  const bridge = await createBridge({
    adminToken: token,
    portStart: 0,
    portEnd: 0,
    logger() {},
  });
  t.after(() => bridge.close());
  const base = `http://127.0.0.1:${bridge.address.port}`;
  async function api(path, body, method = body ? "POST" : "GET") {
    const response = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  }
  const created = await api("/v1/rooms", { ...manifest, ...overrides });
  assert.equal(created.status, 201);
  const room = bridge.rooms.get(created.data.id);
  const events = [];
  async function web(path, player, seed, wait = 0) {
    const socket = new WebSocket(base.replace("http:", "ws:") + path);
    const link = new BridgeConnection(null, socket, {
      player,
      players: 2,
      battery: new Uint8Array(512).fill(seed),
      onError(error) {
        events.push({ player, error: error.message });
      },
      onActionError(message) {
        events.push({ player, action: message });
      },
      async onContent(packet) {
        events.push({
          player,
          cartridges: packet.cartridges.map((rom) => rom.romId),
        });
        await delay(wait);
        return new MemoryCore();
      },
    });
    t.after(() => link.stop());
    await until(() => link.manualStart);
    return link;
  }
  const host = await web(created.data.hostPath, 0, 11);
  return { api, room, host, web, events };
}

test("selected cartridges and saves follow seats before deferred web startup; a removed player does not end the game", async (t) => {
  const { api, room, host, web, events } = await setup(t);
  const joined = await api(`/v1/rooms/${room.id}/join`, {
    owner: "guest",
    romId: 2,
    cartridge: cartridge(2),
  });
  assert.equal(joined.status, 201);
  const guest = await web(joined.data.peerPath, joined.data.player, 22, 40);
  assert.equal(host.adapter, null);
  assert.equal(guest.adapter, null);
  assert.deepEqual(room.seats, [null, null]);
  host.assignPlayer(0, 1);
  guest.assignPlayer(1, 0);
  await until(() => room.canStart());
  guest.removePlayer(0);
  await until(() => events.some((e) => e.action?.includes("Only the host")));
  assert.equal(room.peers.size, 2);
  host.startGame();
  await until(() => host.started && guest.started);
  assert.deepEqual(
    room.manifest.cartridges.map((rom) => rom.romId),
    [2, 1],
  );
  assert.equal(room.manifest.contentCrc, 2);
  assert.equal(room.manifest.stateSize, 1028);
  assert.deepEqual(host.adapter.save(), guest.adapter.save());
  assert(host.adapter.memory(0).every((byte) => byte === 22));
  assert(host.adapter.memory(256).every((byte) => byte === 11));
  assert.deepEqual(
    events.filter((e) => e.cartridges).map((e) => e.cartridges),
    [
      [2, 1],
      [2, 1],
    ],
  );
  assert.deepEqual(
    events.filter((e) => e.error),
    [],
  );
  const removed = room.peers.get(1);
  host.removePlayer(1);
  await until(() => guest.closed && room.peers.size === 1);
  removed.ws.emit("message", Buffer.from("{"), false);
  assert.equal(room.closed, false);
  assert.equal(room.running, true);
  assert.equal(host.closed, false);
  for (let frame = 0; frame < 4; frame++) {
    host.tick(0);
    await delay(10);
  }
  assert(host.session.frame > 0);
  assert.match(events.find((e) => e.player === 1 && e.error).error, /Removed/);
  for (const route of ["join", "native"]) {
    const response = await api(`/v1/rooms/${room.id}/${route}`, {
      owner: "guest",
      romId: 2,
      cartridge: cartridge(2),
    });
    assert.equal(response.status, 409);
    assert.match(response.data.error, /Removed/);
  }
});

test("GB/GBC collects different cartridges and admits another cartridge into the running room for host moderation", async (t) => {
  const { api, room, host, web, events } = await setup(t, {
    system: "gb",
    coreName: "SameBoy",
  });
  assert.equal(
    room.timer,
    undefined,
    "A manual lobby must not expire while its members remain connected",
  );
  const joined = await api(`/v1/rooms/${room.id}/join`, {
    owner: "silver",
    romId: 2,
    cartridge: cartridge(2),
  });
  assert.equal(joined.status, 201);
  const silver = await web(joined.data.peerPath, 1, 22);
  host.assignPlayer(0, 0);
  silver.assignPlayer(1, 1);
  await until(() => room.canStart());
  host.startGame();
  await until(() => host.started && silver.started);
  assert.deepEqual(
    room.manifest.cartridges.map((item) => item.romId),
    [1, 2],
  );
  silver.stop();
  await until(() => room.peers.size === 1);
  const incoming = await api(`/v1/rooms/${room.id}/join`, {
    owner: "another-pack",
    romId: 3,
    cartridge: cartridge(3),
  });
  assert.equal(incoming.status, 201);
  const other = await web(incoming.data.peerPath, 1, 33);
  other.assignPlayer(1, 1);
  await until(() => room.seats[1] === 1);
  assert.equal(room.members().find((member) => member.player === 1).romId, 3);
  assert.deepEqual(
    room.manifest.cartridges.map((item) => item.romId),
    [1, 2],
    "Admission must not replace the currently running cartridges",
  );
  assert(room.running);
  assert(!other.closed);
  host.removePlayer(1);
  await until(() => other.closed && room.peers.size === 1);
  assert(room.running);
  assert.equal(
    events.filter((event) => event.error && !event.error.includes("Removed"))
      .length,
    0,
  );
});

test("only the host can prepare a different lineup, without replacing cartridges during admission", async (t) => {
  const { api, room, host, web, events } = await setup(t, {
    system: "gb",
    coreName: "SameBoy",
  });
  const joined = await api(`/v1/rooms/${room.id}/join`, {
    owner: "silver",
    romId: 2,
    cartridge: cartridge(2),
  });
  const silver = await web(joined.data.peerPath, 1, 22);
  host.assignPlayer(0, 0);
  silver.assignPlayer(1, 1);
  await until(() => room.canStart());
  host.startGame();
  await until(() => host.started && silver.started);
  const originalGeneration = room.generation;
  silver.stop();
  await until(() => room.peers.size === 1);
  const joinedOther = await api(`/v1/rooms/${room.id}/join`, {
    owner: "another-pack",
    romId: 3,
    cartridge: cartridge(3),
  });
  const other = await web(joinedOther.data.peerPath, 1, 33);
  other.assignPlayer(1, 1);
  await until(() => room.seats[1] === 1);
  other.openGame();
  await until(() =>
    events.some((event) => event.action?.includes("next game")),
  );
  assert.equal(
    other.adapter,
    null,
    "The old cartridge must not be downloaded for a different-pack guest",
  );
  other.startGame();
  await until(() =>
    events.some((event) => event.action?.includes("Only the host")),
  );
  assert(room.running);
  assert.equal(room.generation, originalGeneration);
  host.startGame();
  await until(
    () => host.gameClosed && other.gameClosed && !room.contentPrepared,
  );
  assert(!room.running);
  assert.equal(room.peers.size, 2);
  assert(!host.closed && !other.closed);
  assert.deepEqual(room.seats, [0, 1]);
  host.openGame();
  other.openGame();
  await until(() => [...room.peers.values()].every((peer) => !peer.gameClosed));
  host.startGame();
  await until(() => host.started && other.started);
  assert.deepEqual(
    room.manifest.cartridges.map((item) => item.romId),
    [1, 3],
  );
  assert(host.adapter.memory(256).every((byte) => byte === 33));
  assert.deepEqual(
    events.filter((event) => event.error),
    [],
  );
});

test("automatic native admission retries after pause and source checks without starting an idle third member", async (t) => {
  const bridge = await createBridge({
    adminToken: "auto-admission-unit-test-token",
    portStart: 0,
    portEnd: 0,
    logger() {},
  });
  t.after(() => bridge.close());
  const response = await fetch(
    `http://127.0.0.1:${bridge.address.port}/v1/rooms`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer auto-admission-unit-test-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...manifest,
        players: 3,
        maxPrediction: 12,
        nativeAuthority: true,
        cartridges: [cartridge(1), cartridge(2), cartridge(3)],
      }),
    },
  );
  assert.equal(response.status, 201);
  const room = bridge.rooms.get((await response.json()).id);
  room.reservations.clear();
  const native = (player, playing) => ({
    kind: "native",
    player,
    owner: `owner-${player}`,
    cartridge: cartridge(player + 1),
    playing,
    ready: true,
    bootstrapped: true,
    nextFrame: 100,
    close() {},
    start() {},
    finishStart() {},
    prepareRestart() {
      this.restartReady = true;
    },
    requestResumeSource(id) {
      this.requestedResume = id;
    },
  });
  const source = native(0, true),
    target = native(1, false),
    messages = [];
  const idle = {
    kind: "web",
    player: 2,
    gameClosed: true,
    playing: false,
    ws: {
      readyState: 1,
      bufferedAmount: 0,
      close() {},
      send(value) {
        messages.push(JSON.parse(value));
      },
    },
  };
  room.peers = new Map([
    [0, source],
    [1, target],
    [2, idle],
  ]);
  room.seats = [0, 1, null];
  room.gameSeats = [0, 1, 2];
  room.started = room.running = room.hadGame = true;
  source.checkpointRequested = true;
  room.resumeGame(target);
  assert.equal(target.resumeId, undefined);
  source.checkpointRequested = false;
  room.paused = true;
  room.resumeGame(target);
  assert.equal(target.resumeId, undefined);
  room.paused = false;
  room.resumeGame(target);
  assert.equal(source.requestedResume, target.resumeId);
  assert(target.resumeId);
  room.completeResume(source, target.resumeId, 100, Buffer.alloc(128, 7));
  assert(room.running && target.playing && source.playing);
  assert.equal(idle.playing, false);
  assert.equal(room.seats[2], null);
  assert.deepEqual(room.gameSeats, [0, 1, 2]);
  assert(room.state.equals(Buffer.alloc(128, 7)));
  assert(
    messages.every(
      (packet) => !["prepare", "start", "state"].includes(packet.t),
    ),
  );
});

test("pending Windows cartridges are collected by seat and scoped downloads stay pending until the host has a state", async (t) => {
  const { api, room, host, web } = await setup(t);
  const pending = await api(`/v1/rooms/${room.id}/native`, {
    owner: "guest",
    romId: 2,
    cartridge: cartridge(2),
    clientPlatform: "windows-x86_64",
    battery: "AQID",
  });
  assert.equal(pending.status, 201);
  const route = `/v1/rooms/${room.id}/native/${pending.data.credential}`;
  assert.equal((await api(route)).data.pending, true);
  assert.equal((await api(route, { seat: 0 }, "PATCH")).status, 200);
  host.assignPlayer(0, 1);
  await until(() => room.canStart());
  host.startGame();
  await until(() => room.state !== null);
  const ready = (await api(route)).data;
  assert.equal(ready.pending, false);
  assert.deepEqual(
    ready.cartridges.map((rom) => rom.romId),
    [2, 1],
  );
  assert.equal(!!room.running, false);
  host.removePlayer(1);
  await until(() => !room.reservations.has(1));
  assert.equal((await api(route)).status, 404);
  assert.equal(host.closed, false);
  assert.equal(room.loadingContent, false);
  const joined = await api(`/v1/rooms/${room.id}/join`, {
    owner: "replacement",
    romId: 2,
    cartridge: cartridge(2),
  });
  assert.equal(joined.status, 201);
  const replacement = await web(joined.data.peerPath, joined.data.player, 33);
  replacement.assignPlayer(joined.data.player, 0);
  await until(() => room.canStart());
  host.startGame();
  await until(() => replacement.started && host.started);
  assert(host.adapter.memory(0).every((value) => value === 33));
});
