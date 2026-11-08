import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { createBridge } from "../server.mjs";
import { BridgeConnection } from "../client/bridge-session.js";

class Core {
  size = 64;
  data = new Uint8Array(64);
  profile = { core: "fixture", memoryIds: [0, 1, 2] };
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
    buttons.forEach((value, seat) =>
      view.setUint32(8 + seat * 4, view.getUint32(8 + seat * 4) + value),
    );
  }
}

async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail("Lobby condition timed out");
}

test("unassigned lobby enforces own-slot selection and host start, preserving saves and input mapping", async (t) => {
  const adminToken = "lobby-test-service-credential-123";
  const bridge = await createBridge({ adminToken });
  const base = `http://127.0.0.1:${bridge.address.port}`;
  const clients = [];
  t.after(async () => {
    clients.forEach((client) => client.stop());
    await bridge.close();
  });
  async function api(path, body) {
    const response = await fetch(base + "/v1/rooms" + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 201);
    return response.json();
  }
  function connect(path, player, seed) {
    const socket = new WebSocket(base.replace("http:", "ws:") + path);
    let core = new Core();
    const actions = [],
      errors = [];
    let lobby;
    let latency;
    const client = new BridgeConnection(core, socket, {
      player,
      players: 3,
      battery: Uint8Array.of(seed),
      onLobby: (value) => {
        lobby = value;
      },
      onActionError: (error) => actions.push(error),
      onLatency: (value) => {
        latency = value;
      },
      onError: (error) => errors.push(error.message),
      onContent: async () => (core = new Core()),
    });
    clients.push(client);
    return {
      client,
      get core() {
        return core;
      },
      actions,
      errors,
      get lobby() {
        return lobby;
      },
      get latency() {
        return latency;
      },
    };
  }
  const room = await api("", {
    system: "gba",
    coreName: "mGBA Splitscreen",
    coreVersion: "test",
    contentCrc: 1,
    stateSize: 64,
    players: 3,
    manualStart: true,
    owner: "host",
    password: "",
  });
  const host = connect(room.hostPath, 0, 11);
  await until(() => host.lobby);
  const guest = connect(
    (await api(`/${room.id}/join`, { owner: "guest" })).peerPath,
    1,
    22,
  );
  let third = connect((await api(`/${room.id}/join`, {})).peerPath, 2, 33);
  await until(() => host.lobby.members.length === 3 && third.lobby);
  assert.deepEqual(host.lobby.seats, [null, null, null]);
  assert.equal(host.lobby.canStart, false);
  host.client.startGame();
  await until(() => host.actions.length);
  assert.equal(host.client.started, false);
  guest.client.assignPlayer(0, 0);
  await until(() => guest.actions.length === 1);
  assert.match(guest.actions[0], /own player number/);
  guest.client.assignPlayer(1, 0);
  host.client.assignPlayer(0, 2);
  await until(() => third.lobby.seats[1] === 0);
  third.client.assignPlayer(2, 0);
  await until(() => third.actions.length);
  assert.match(third.actions[0], /already selected/);
  third.client.assignPlayer(2, 1);
  await until(() => host.lobby.canStart);
  guest.client.startGame();
  await until(() => guest.actions.length === 2);
  assert.match(guest.actions[1], /Only the host/);
  assert(clients.every((client) => !client.started));
  third.client.stop();
  await until(() => host.lobby.members.length === 2);
  assert.equal(host.lobby.seats[2], null);
  assert.equal(host.lobby.canStart, false);
  third = connect((await api(`/${room.id}/join`, {})).peerPath, 2, 33);
  await until(() => third.lobby);
  assert.equal(third.lobby.seats[2], null);
  host.client.assignPlayer(2, 1);
  await until(() => host.lobby.canStart);
  host.client.startGame();
  const active = [host, guest, third];
  await until(() => active.every(({ client }) => client.started));
  for (const { core } of active)
    assert.deepEqual([...core.data.subarray(0, 3)], [22, 33, 11]);
  for (
    let i = 0;
    i < 200 && active.some(({ client }) => client.session.frame < 30);
    i++
  ) {
    active.forEach(({ client }, index) => {
      if (client.session.frame < 30) client.tick(4 << index);
    });
    await delay(1);
  }
  for (const { client, core, errors } of active) {
    assert.equal(client.session.frame, 30);
    assert.deepEqual(core.save(), host.core.save());
    assert.deepEqual(errors, []);
  }
  const state = new DataView(host.core.data.buffer);
  assert.equal(state.getUint32(8), 2 * state.getUint32(16));
  assert.equal(state.getUint32(12), 4 * state.getUint32(16));

  const serverRoom = bridge.rooms.get(room.id);
  serverRoom.probePeers();
  await until(() =>
    host.latency?.every((member) => Number.isFinite(member.ping)),
  );
  assert.equal(host.latency.length, 3);

  async function advance(group, frame) {
    for (
      let i = 0;
      i < 1000 && group.some(({ client }) => client.session.frame < frame);
      i++
    ) {
      group.forEach(({ client }, index) => {
        if (client.session.frame < frame) client.tick(1 << index);
      });
      await delay(1);
    }
    await until(() =>
      group.every(({ client }) => client.session.confirmed === frame),
    );
    assert(group.every(({ client }) => !client.closed));
    assert(
      group.every(({ core }) =>
        Buffer.from(core.save()).equals(Buffer.from(group[0].core.save())),
      ),
    );
  }

  third.client.stop();
  await until(() => host.lobby.members.length === 2);
  await advance([host, guest], 90);
  const beforeJoin = host.client.session.frame;
  third = connect((await api(`/${room.id}/join`, {})).peerPath, 2, 44);
  await until(() => third.lobby?.members.length === 3);
  assert.equal(third.client.started, false);
  assert.equal(third.lobby.seats[2], null);
  await advance([host, guest], 120);
  assert(host.client.session.frame > beforeJoin);
  third.client.assignPlayer(2, 1);
  await until(() => host.lobby.canStart);
  for (const { core } of [host, guest]) {
    core.data[0] = 77;
    core.data[2] = 88;
  }
  host.client.startGame();
  await until(() =>
    [host, guest, third].every(({ client }) => client.gameClosed),
  );
  for (const { client } of [host, guest, third]) client.openGame();
  await until(() => host.lobby.canStart);
  host.client.startGame();
  await until(() =>
    [host, guest, third].every(
      ({ client }) => client.started && client.generation === 3,
    ),
  );
  for (const { core } of [host, guest, third])
    assert.deepEqual([...core.data.subarray(0, 3)], [77, 44, 88]);
  await advance([host, guest, third], 30);

  host.client.stop();
  await until(() => guest.lobby.host === 1 && guest.lobby.members.length === 2);
  assert.equal(serverRoom.metadata().owner, "guest");
  await advance([guest, third], 90);
  const joined = await api(`/${room.id}/join`, {});
  assert.equal(joined.player, 0);
  const replacement = connect(joined.peerPath, 0, 55);
  await until(() => replacement.lobby?.members.length === 3);
  replacement.client.assignPlayer(0, 2);
  await until(() => guest.lobby.canStart);
  guest.client.startGame();
  await until(() =>
    [guest, third, replacement].every(({ client }) => client.gameClosed),
  );
  for (const { client } of [guest, third, replacement]) client.openGame();
  await until(() => guest.lobby.canStart);
  guest.client.startGame();
  await until(() =>
    [guest, third, replacement].every(
      ({ client }) => client.started && client.generation === 5,
    ),
  );
  await advance([guest, third, replacement], 70);
  assert(
    [guest, third, replacement].every(({ errors }) => errors.length === 0),
  );
  clients.forEach((client) => client.stop());
  await until(() => !bridge.rooms.has(room.id));
});
