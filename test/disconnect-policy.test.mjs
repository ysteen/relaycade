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
  load(b) {
    this.data.set(b);
  }
  memory(id) {
    return this.data.subarray(id, id + 1);
  }
  loadMemory(id, b) {
    this.memory(id).set(b);
  }
  stepPlayers(buttons) {
    this.data[8]++;
    buttons.forEach((b, p) => {
      this.data[16 + p] += b;
    });
  }
}
async function until(check) {
  for (let n = 0; n < 300; n++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail("Disconnect policy transition timed out");
}
async function setup(t, policy = "pause", players = 2) {
  const token = "disconnect-policy-test-token",
    bridge = await createBridge({ adminToken: token, logger() {} }),
    clients = [],
    errors = [];
  t.after(async () => {
    clients.forEach((c) => c.stop());
    await bridge.close();
  });
  const base = `http://127.0.0.1:${bridge.address.port}`;
  async function api(path, body) {
    const r = await fetch(base + "/v1/rooms" + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  }
  const created = await api("", {
    system: "gba",
    coreName: "mGBA Splitscreen",
    coreVersion: "test",
    contentCrc: 1,
    stateSize: 64,
    players,
    owner: "owner0",
    romId: 1,
    manualStart: true,
    password: "",
    disconnectPolicy: policy,
  });
  assert.equal(created.status, 201);
  const room = bridge.rooms.get(created.body.id);
  for (let p = 0; p < players; p++) {
    const joined =
      p === 0
        ? created
        : await api("/" + room.id + "/join", { owner: "owner" + p, romId: 1 });
    assert.equal(joined.status, 201, JSON.stringify(joined.body));
    const path = p === 0 ? joined.body.hostPath : joined.body.peerPath;
    clients.push(
      new BridgeConnection(
        new Core(),
        new WebSocket(
          base.replace("http:", "ws:") + path + "&retainRoom=1&manualJoin=1",
        ),
        {
          player: p,
          players,
          manualJoin: true,
          onContent: async () => new Core(),
          onError: (e) => errors.push(e.message),
          onActionError: (e) => errors.push(e),
        },
      ),
    );
  }
  await until(() => clients.every((c) => c.manualStart));
  clients.forEach((c, p) => {
    c.assignPlayer(p, p);
    c.openGame();
  });
  await until(() => room.canStart());
  clients[0].startGame();
  await until(() => clients.every((c) => c.started));
  async function advance(frames) {
    for (
      let i = 0;
      i < frames * 5 &&
      clients.some((c) => c.started && c.session.frame < frames);
      i++
    ) {
      for (const c of clients)
        if (c.started && c.session.frame < frames) c.tick(1);
      await delay(1);
    }
    assert.deepEqual(errors, []);
  }
  await advance(30);
  return { room, clients, errors, advance, api };
}
test("pause freezes web play until every missing player rejoins the same state", async (t) => {
  const { room, clients, errors, advance } = await setup(t, "pause", 3);
  clients[1].closeGame();
  clients[2].closeGame();
  await until(() => clients[0].session.paused);
  const frame = clients[0].session.frame,
    generation = room.generation;
  for (let i = 0; i < 30; i++) clients[0].tick(1);
  assert.equal(clients[0].session.frame, frame);
  assert.deepEqual(room.metadata().waitingForPlayers.sort(), [1, 2]);
  const state = clients[0].session.stateAt(clients[0].session.confirmed);
  clients[1].openGame();
  await until(() => room.peers.get(1).contentReady);
  assert.equal(room.generation, generation);
  assert(room.paused);
  clients[2].openGame();
  await until(
    () => clients.every((c) => c.started) && room.generation > generation,
  );
  assert(!room.paused);
  assert.equal(room.disconnectedPlayers.size, 0);
  assert.deepEqual(clients[0].adapter.save(), state);
  await advance(90);
  assert.deepEqual(errors, []);
});
test("continue preserves gameplay and only the host can change the policy", async (t) => {
  const { room, clients, advance, api, errors } = await setup(t, "continue");
  clients[1].closeGame();
  await until(() => room.peers.get(1).gameClosed);
  await advance(60);
  assert(!room.paused);
  assert.equal(
    (
      await api("/" + room.id + "/control", {
        owner: "owner1",
        t: "disconnect-policy",
        disconnectPolicy: "pause",
      })
    ).status,
    409,
  );
  await until(() => errors.length === 1);
  assert.match(errors.shift(), /Only the host/);
  assert.equal(
    (
      await api("/" + room.id + "/control", {
        owner: "owner0",
        t: "disconnect-policy",
        disconnectPolicy: "pause",
      })
    ).status,
    200,
  );
  await until(() => clients[0].session.paused);
  assert.equal(
    (
      await api("/" + room.id + "/control", {
        owner: "owner0",
        t: "disconnect-policy",
        disconnectPolicy: "continue",
      })
    ).status,
    200,
  );
  await until(() => !clients[0].session.paused);
  await advance(90);
});
test("automatic recovery preserves a manual pause", async (t) => {
  const { room, clients } = await setup(t);
  clients[0].pause(true);
  await until(() => room.paused);
  clients[1].closeGame();
  await until(() => room.disconnectPause);
  const generation = room.generation;
  clients[1].openGame();
  await until(
    () => clients.every((c) => c.started) && room.generation > generation,
  );
  assert(room.manualPaused);
  await until(() => clients.every((c) => c.session.paused));
  clients[0].pause(false);
  await until(() => clients.every((c) => !c.session.paused));
});
test("native recovery releases only its source and pauses again on failure", async (t) => {
  const { room, clients } = await setup(t);
  clients[1].closeGame();
  await until(() => room.disconnectPause);
  const commands = [];
  const native = {
    ...room.peers.get(0),
    kind: "native",
    send: (...args) => commands.push(args),
    setRoomPaused: (paused) => commands.push([paused ? "hold" : "release"]),
    requestResumeSource(id) {
      this.resumeSourceId = id;
    },
    close() {},
    playing: true,
  };
  room.peers.set(0, native);
  const target = room.peers.get(1);
  target.gameClosed = false;
  target.contentReady = true;
  target.resumeAllowed = true;
  room.resumeDisconnectedPlayers();
  assert.equal(commands[0][0], "release");
  assert(room.disconnectPause.recovering);
  const request = [...room.resumes.values()][0];
  assert.equal(request.source, native);
  room.cancelResume(request, "test failure");
  assert(room.paused);
  assert(!room.disconnectPause.recovering);
  assert.equal(commands.at(-1)[0], "hold");
});

test("leaving the room detaches the cable while pause still allows the host to continue", async (t) => {
  const { room, clients, api } = await setup(t);
  room.manifest.inputProfile = "link-cable-r3-v1";
  clients[1].stop();
  await until(() => room.paused && !room.peers.has(1));
  assert(room.detached.has(1));
  assert.equal(
    (
      await api("/" + room.id + "/control", {
        owner: "owner0",
        t: "disconnect-policy",
        disconnectPolicy: "continue",
      })
    ).status,
    200,
  );
  await until(() => !clients[0].session.paused);
});
