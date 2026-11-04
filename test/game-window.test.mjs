import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { createBridge } from "../server.mjs";
import { BridgeConnection } from "../client/bridge-session.js";

class Core {
  size = 64;
  data = new Uint8Array(64);
  profile = { core: "fixture", memoryIds: [0, 1] };
  save() {
    return this.data.slice();
  }
  load(bytes) {
    this.data.set(bytes);
  }
  memory(id) {
    return this.data.subarray(id, id + 1);
  }
  loadMemory(id, bytes) {
    this.memory(id).set(bytes);
  }
  stepPlayers(buttons) {
    const view = new DataView(this.data.buffer);
    buttons.forEach((value, player) =>
      view.setUint32(8 + player * 4, view.getUint32(8 + player * 4) + value),
    );
  }
}
async function until(predicate) {
  for (let n = 0; n < 300; n++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail("Game window transition timed out");
}

test("closing a game retains membership and ping; reopening catches up without resetting the running game", async (t) => {
  const token = "game-window-test-service-token";
  const bridge = await createBridge({ adminToken: token, logger() {} });
  const base = `http://127.0.0.1:${bridge.address.port}`;
  const clients = [],
    errors = [],
    pings = [];
  t.after(async () => {
    clients.forEach((client) => client.stop());
    await bridge.close();
  });
  async function api(path, data) {
    const response = await fetch(base + "/v1/rooms" + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
    const result = await response.json();
    assert.equal(
      response.status,
      path.endsWith("/leave") ? 200 : 201,
      JSON.stringify(result),
    );
    return result;
  }
  const cartridges = [1, 2].map((romId) => ({
    romId,
    size: 32768,
    crc32: romId,
    sha256: String(romId).repeat(64),
  }));
  const created = await api("", {
    romId: 1,
    system: "gba",
    coreName: "mGBA Splitscreen",
    coreVersion: "test",
    contentCrc: 1,
    stateSize: 64,
    players: 2,
    manualStart: true,
    maxPrediction: 12,
    owner: "host",
    password: "",
    cartridges,
  });
  const room = bridge.rooms.get(created.id);
  function connect(path, player) {
    const client = new BridgeConnection(
      new Core(),
      new WebSocket(base.replace("http:", "ws:") + path + "&manualJoin=1"),
      {
        player,
        players: 2,
        maxPrediction: 12,
        manualJoin: true,
        battery: Uint8Array.of(11 + player),
        onContent: async () => new Core(),
        onError: (e) => errors.push(e.message),
        onActionError: (e) => errors.push(e),
        onLatency: (value) => {
          pings[player] = value;
        },
      },
    );
    clients.push(client);
    return client;
  }
  const host = connect(created.hostPath, 0);
  const joined = await api(`/${created.id}/join`, { owner: "guest", romId: 2 });
  let guest = connect(joined.peerPath, 1);
  await until(() => clients.every((client) => client.manualStart));
  host.assignPlayer(0, 0);
  guest.assignPlayer(1, 1);
  await until(() => room.seats.every((seat) => seat !== null));
  assert.equal(room.canStart(), false);
  assert(room.members().every((member) => !member.ready));
  host.openGame();
  await until(() => room.peers.get(0).resumeAllowed);
  assert.equal(room.canStart(), false);
  guest.openGame();
  await until(() => room.canStart());
  host.startGame();
  await until(() => clients.every((client) => client.started));
  async function advance(active, frame) {
    for (
      let n = 0;
      n < 1500 && active.some((c) => c.session.frame < frame);
      n++
    ) {
      active.forEach((client) => {
        if (client.session.frame < frame) client.tick(client.player + 1);
      });
      await delay(1);
    }
    await until(() =>
      active.every((client) => client.session.confirmed === frame),
    );
    assert.deepEqual(errors, []);
    active.forEach((client) => assert.equal(client.session.frame, frame));
  }
  await advance(clients, 40);
  const generation = room.generation,
    session = host.session;
  guest.closeGame();
  await until(() => room.peers.get(1).gameClosed);
  assert.equal(guest.closed, false);
  assert.equal(room.members().length, 2);
  assert.deepEqual(room.seats, [0, 1]);
  assert.equal(room.members()[1].ready, false);
  await advance([host], 100);
  room.probePeers();
  await until(() => pings[1]?.every((p) => Number.isFinite(p.ping)));
  guest.openGame();
  await until(() => {
    assert.deepEqual(errors, []);
    return guest.started;
  });
  assert.equal(room.generation, generation);
  assert.equal(host.session, session);
  assert.equal(guest.session.frame, 100);
  // Both clients run at the same rate after a delayed resume snapshot.
  for (let n = 0; n < 10; n++) {
    host.tick(1);
    await delay(1);
  }
  const delayedBy = host.session.frame - guest.session.frame;
  assert(delayedBy >= 8);
  for (let n = 0; n < 40; n++) {
    host.tick(1);
    guest.tick(2);
    await delay(1);
  }
  assert(
    host.session.frame - guest.session.frame <= 4,
    "Web rejoin retained its initial delay despite equal tick rates",
  );
  assert(guest.hostFrame >= 100, "A web host did not publish its frame clock");
  await advance(clients, 180);
  assert.deepEqual(host.adapter.save(), guest.adapter.save());
  assert(host.session.stats.checks >= 3);
  host.closeGame();
  await until(() => room.host === 1);
  await advance([guest], 240);
  host.openGame();
  await until(() => host.started);
  await advance(clients, 300);
  assert.deepEqual(host.adapter.save(), guest.adapter.save());
  assert.equal(room.generation, generation);
  guest.stop();
  await until(() => room.peers.size === 1);
  await advance([host], 360);
  const rejoined = await api(`/${created.id}/join`, {
    owner: "guest",
    romId: 2,
  });
  guest = connect(rejoined.peerPath, 1);
  await until(() => guest.manualStart);
  guest.assignPlayer(1, 1);
  await until(() => room.seats[1] === 1);
  await advance([host], 400);
  assert.equal(guest.started, false, "Choosing P2 must not join the web game");
  assert.equal(room.peers.get(1).playing, false);
  guest.openGame();
  await until(() => guest.started);
  await advance([host, guest], 460);
  assert.deepEqual(host.adapter.save(), guest.adapter.save());
  assert.equal(room.generation, generation);
  await api(`/${created.id}/leave`, { owner: "host" });
  await until(() => room.members().length === 1);
  await advance([guest], 500);
  room.reserve(0, "pending-windows", "Windows", { kind: "native" });
  await api(`/${created.id}/leave`, { owner: "pending-windows" });
  assert.equal(room.reservations.size, 0);
  let nativeDropped = false;
  const native = {
    kind: "native",
    owner: "windows",
    player: 0,
    nickname: "Windows",
    playing: false,
    drop() {
      nativeDropped = true;
      room.depart(native, "Left the room");
    },
  };
  room.peers.set(0, native);
  await api(`/${created.id}/leave`, { owner: "windows" });
  assert(nativeDropped);
  assert.equal(guest.closed, false);
  guest.closeGame();
  await until(() => !room.running);
  assert.equal(room.closed, false);
  assert.equal(room.members().length, 1);
  guest.stop();
  await until(() => !bridge.rooms.has(created.id));
  assert.deepEqual(errors, []);
});
