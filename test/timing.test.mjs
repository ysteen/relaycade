import test from "node:test";
import assert from "node:assert/strict";
import { createBridge } from "../server.mjs";
import { CMD } from "../wire.mjs";

test("timing logs distinguish native input lead from network RTT and skip waiting members", async (t) => {
  const adminToken = "timing-test-token-at-least-24-characters";
  const service = await createBridge({ adminToken, logger() {} });
  t.after(() => service.close());
  const response = await fetch(
    `http://127.0.0.1:${service.address.port}/v1/rooms`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        system: "gb",
        coreName: "SameBoy",
        coreVersion: "test",
        players: 2,
        stateSize: 128,
        contentCrc: 1,
      }),
    },
  );
  assert.equal(response.status, 201);
  const room = service.rooms.get((await response.json()).id);
  room.logTiming();
  assert.equal(
    room.bridge.admin.logs().events.filter((e) => e.event === "game-timing")
      .length,
    0,
  );
  room.running = true;
  room.generation = 4;
  room.host = 0;
  room.peers.set(0, {
    player: 0,
    kind: "native",
    playing: true,
    lastReportedFrame: 105,
    frameOffset: 5,
    ping: 10,
    socket: { writableLength: 0 },
  });
  room.peers.set(1, {
    player: 1,
    kind: "native",
    playing: true,
    lastReportedFrame: 103,
    frameOffset: 1,
    ping: 23,
    socket: { writableLength: 12 },
  });
  room.peers.set(2, { player: 2, kind: "web", playing: false });
  try {
    room.logTiming();
    const events = room.bridge.admin
      .logs()
      .events.filter((e) => e.event === "game-timing");
    assert.equal(events.length, 2);
    const guest = events.find((e) => e.fields.player === 1).fields;
    assert.equal(guest.inputFrame, 102);
    assert.equal(guest.hostFrame, 100);
    assert.equal(guest.inputLeadFrames, 2);
    assert.equal(guest.pingMs, 23);
    assert.equal(guest.hostPingMs, 10);
    assert.equal(guest.queuedBytes, 12);
    assert.equal(guest.generation, 4);
  } finally {
    room.running = false;
    room.peers.clear();
  }
});

test("native pacing keeps a stable slowest reference, including when the room host is ahead", async (t) => {
  const adminToken = "native-clock-test-at-least-24-characters";
  const service = await createBridge({ adminToken, logger() {} });
  t.after(() => service.close());
  const response = await fetch(
    `http://127.0.0.1:${service.address.port}/v1/rooms`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        system: "gba",
        coreName: "mGBA Splitscreen",
        coreVersion: "test",
        players: 4,
        stateSize: 128,
        contentCrc: 1,
      }),
    },
  );
  assert.equal(response.status, 201);
  const room = service.rooms.get((await response.json()).id);
  const host = { player: 0, kind: "native", playing: true, frame: 100 };
  const guest = { player: 1, kind: "native", playing: true, frame: 100 };
  const other = { player: 2, kind: "native", playing: true, frame: 102 };
  const waiting = { player: 3, kind: "web", playing: false, frame: 0 };
  room.peers = new Map([host, guest, other, waiting].map((p) => [p.player, p]));
  try {
    assert.equal(room.nativePacingReference(), host);
    guest.frame = 99;
    assert.equal(room.nativePacingReference(), host);
    host.frame = 110;
    assert.equal(room.nativePacingReference(), guest);
    host.frame = 98;
    assert.equal(room.nativePacingReference(), guest);
    guest.playing = false;
    assert.equal(room.nativePacingReference(), host);
    assert.equal(room.host, 0, "Pacing must not transfer room ownership");
    waiting.playing = true;
    assert.equal(room.nativePacingReference(), host);
    assert.equal(room.nativePacingSource, null);
  } finally {
    room.peers.clear();
  }
});

test("intentional pause retains native peers while web and resumed native heartbeats still expire", async (t) => {
  const adminToken = "paused-heartbeat-test-at-least-24-characters";
  const service = await createBridge({ adminToken, logger() {} });
  t.after(() => service.close());
  const response = await fetch(
    `http://127.0.0.1:${service.address.port}/v1/rooms`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        system: "gb",
        coreName: "SameBoy",
        coreVersion: "test",
        players: 2,
        stateSize: 128,
        contentCrc: 1,
      }),
    },
  );
  assert.equal(response.status, 201);
  const room = service.rooms.get((await response.json()).id);
  const sent = [],
    dropped = [];
  let webTerminated = 0,
    keptAlive = 0;
  const native = {
    player: 0,
    kind: "native",
    phase: "connected",
    ready: true,
    playing: true,
    ping: 23,
    probe: { sent: performance.now() - 20000, nonce: "before-pause" },
    lastReportedFrame: 100,
    frameOffset: 0,
    socket: { writableLength: 0 },
    keepLobbyAlive() {
      keptAlive++;
    },
    send(command) {
      sent.push(command);
    },
    drop(reason) {
      dropped.push(reason);
    },
  };
  room.running = room.paused = true;
  room.lastSaveCapture = Date.now();
  room.peers.set(0, native);
  room.peers.set(1, {
    player: 1,
    kind: "web",
    playing: false,
    probe: { sent: performance.now() - 20000, nonce: "stale-web" },
    ws: {
      readyState: 3,
      terminate() {
        webTerminated++;
      },
    },
  });
  try {
    room.probePeers();
    assert(
      native.probe,
      "The old PONG must remain ordered before a restart barrier",
    );
    assert.equal(native.ping, 23);
    assert.deepEqual(dropped, []);
    assert.deepEqual(sent, []);
    assert.equal(webTerminated, 1);

    room.peers.delete(1);
    room.paused = false;
    room.probePeers();
    assert.deepEqual(sent, []);
    assert.deepEqual(dropped, []);
    room.pong(native);
    assert.equal(native.ping, 23, "Paused time must not enter the RTT average");
    assert.equal(native.probe, null);
    room.probePeers();
    assert.deepEqual(sent, [CMD.PING]);
    assert.equal(keptAlive, 1);
    assert(performance.now() - native.probe.sent < 1000);
    assert.deepEqual(dropped, []);

    native.probe.sent = performance.now() - 20000;
    room.probePeers();
    assert.deepEqual(dropped, ["Native heartbeat timed out"]);
  } finally {
    room.running = false;
    room.peers.clear();
  }
});
