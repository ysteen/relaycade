import test from "node:test";
import assert from "node:assert/strict";
import { createBridge } from "../server.mjs";
import { BridgeSession } from "../client/bridge-session.js";
import {
  CABLE_INPUT,
  CABLE_INPUT_PROFILE,
  cableInputProfile,
} from "../client/link-core.js";

async function fixture(t, coreVersion = "0.1.0-f1d5975-cable1", players = 2) {
  const adminToken = "cable-test-disposable-service-credential";
  const bridge = await createBridge({ adminToken });
  t.after(() => bridge.close());
  const response = await fetch(
    `http://127.0.0.1:${bridge.address.port}/v1/rooms`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        system: "gba",
        players,
        stateSize: 64,
        contentCrc: 1,
        coreName: "mGBA Splitscreen",
        coreVersion,
        manualStart: true,
      }),
    },
  );
  assert.equal(response.status, 201);
  const room = bridge.rooms.get((await response.json()).id);
  room.reservations.clear();
  room.seats = Array.from({ length: players }, (_, p) => p);
  room.gameSeats = room.seats.slice();
  room.started = room.running = room.hadGame = true;
  const messages = [];
  for (let player = 0; player < players; player++)
    room.peers.set(player, {
      player,
      kind: "web",
      playing: true,
      nextFrame: 5,
      frame: 3,
      confirmed: 3,
      owner: `owner-${player}`,
      ws: {
        readyState: 1,
        send: (data) => messages.push([player, JSON.parse(data)]),
        close() {},
      },
    });
  return { room, messages };
}

for (const players of [2, 3, 4]) {
  for (let leaving = 0; leaving < players; leaving++) {
    test(`${players} players: departing slot ${leaving} unplugs after accepted inputs`, async (t) => {
      const { room, messages } = await fixture(t, undefined, players);
      const departed = room.peers.get(leaving);
      room.depart(departed, "Connection lost");
      const survivor = [...room.peers.values()][0];
      room.input(survivor, 5, 1);
      assert.equal(room.inputHistory[leaving].get(5), CABLE_INPUT);
      assert.equal(room.inputHistory[leaving].has(4), false);
      assert.equal(room.running, true);
      assert.equal(room.peers.size, players - 1);
      assert(
        messages.some(
          ([, packet]) =>
            packet.t === "input" &&
            packet.player === leaving &&
            packet.b === CABLE_INPUT,
        ),
      );
      assert.throws(() => room.input(survivor, 6, CABLE_INPUT), /reserved/);
      assert.equal(survivor.nextFrame, 6);
    });
  }
}

test("closing the game retains cable until the room connection leaves", async (t) => {
  const { room } = await fixture(t);
  const guest = room.peers.get(1),
    host = room.peers.get(0);
  room.closeGame(guest);
  room.input(host, 5, 0);
  assert.equal(room.inputHistory[1].get(5), 0);
  room.depart(guest, "Left room");
  room.input(host, 6, 0);
  assert.equal(room.inputHistory[1].get(5), 0);
  assert.equal(room.inputHistory[1].get(6), CABLE_INPUT);
});

test("native exit with a retained browser does not detach the cable", async (t) => {
  const { room } = await fixture(t);
  const controller = room.peers.get(1);
  room.controllers.set(1, controller);
  const native = { ...controller, kind: "native" };
  room.peers.set(1, native);
  room.depart(native, "Native exit");
  room.input(room.peers.get(0), 5, 0);
  assert.equal(room.peers.get(1), controller);
  assert.equal(room.inputHistory[1].get(5), 0);
  room.depart(controller, "Browser closed");
  room.input(room.peers.get(0), 6, 0);
  assert.equal(room.inputHistory[1].get(6), CABLE_INPUT);
});

for (const action of ["leave", "kick", "expire"])
  test(`a disconnected Windows preparation unplugs on ${action}`, async (t) => {
    const { room } = await fixture(t);
    room.closeGame(room.peers.get(1));
    room.peers.delete(1);
    room.reservations.set(1, {
      kind: "native",
      owner: "owner-1",
      until: Date.now() - 1,
    });
    if (action === "leave") room.leaveOwner("owner-1");
    else if (action === "kick")
      room.control(room.peers.get(0), { t: "kick", player: 1 });
    else room.expireReservations();
    room.input(room.peers.get(0), 5, 0);
    assert.equal(room.inputHistory[1].get(5), CABLE_INPUT);
  });

test("old cores retain neutral input without interpreting R3 as cable state", async (t) => {
  const { room } = await fixture(t, "0.1.0-f1d5975-rollback2");
  room.depart(room.peers.get(1), "Left room");
  room.input(room.peers.get(0), 5, CABLE_INPUT);
  assert.equal(room.inputHistory[1].get(5), 0);
  assert.equal(cableInputProfile("Snes9x", "1.632d4cce69"), null);
});

test("reserved local R3 is stripped while remote cable flags survive rollback", () => {
  const values = new Uint32Array(3);
  const core = {
    save: () => new Uint8Array(values.buffer.slice(0)),
    load: (state) => new Uint8Array(values.buffer).set(state),
    stepPlayers: (buttons) => {
      values[0]++;
      values[1] += buttons[0];
      values[2] += buttons[1];
    },
  };
  const packets = [];
  const session = new BridgeSession(core, {
    player: 0,
    players: 2,
    maxPrediction: 12,
    inputProfile: CABLE_INPUT_PROFILE,
    send: (p) => packets.push(p),
  });
  session.start();
  session.receive({ player: 1, f: 0, b: 0 });
  session.tick(CABLE_INPUT | 1);
  session.tick(CABLE_INPUT | 1);
  session.tick(CABLE_INPUT | 1);
  session.receive({ player: 1, f: 1, b: CABLE_INPUT });
  session.receive({ player: 1, f: 2, b: CABLE_INPUT });
  assert.equal(values[2], CABLE_INPUT * 2);
  assert(session.stats.rollbacks > 0);
  assert(
    packets.filter((p) => p.t === "input").every((p) => !(p.b & CABLE_INPUT)),
  );
});
