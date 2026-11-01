import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { NativePeer } from "../native.mjs";
import { CMD, words } from "../wire.mjs";

class Socket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  packets = [];
  setNoDelay() {}
  write(bytes) {
    this.packets.push({
      command: bytes.readUInt32BE(0),
      data: bytes.subarray(8),
    });
  }
  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}

function fixture(
  t,
  {
    maxPrediction = 8,
    autoStart = true,
    manualStart = false,
    seats = [0, 1],
  } = {},
) {
  const socket = new Socket();
  const inputs = [];
  const events = [];
  const room = {
    manifest: { maxPrediction, stateSize: 128, manualStart },
    seats,
    lobby() {},
    password: "",
    state: Buffer.alloc(128, 7),
    peers: new Map([[0, { player: 0, nickname: "Web" }]]),
    started: true,
    running: false,
    notify() {},
    depart() {},
    input(peer, frame, buttons) {
      assert.equal(frame, peer.nextFrame++);
      inputs.push({ frame, player: peer.player, buttons });
      events.push("input");
    },
    finishStart() {
      if (!autoStart) return;
      this.running = true;
      peer.finishStart();
      events.push("web-start");
      peer.flushInputs();
    },
  };
  const peer = new NativePeer(room, socket, 1);
  peer.protocol = 7;
  peer.compressed = false;
  peer.phase = "connected";
  peer.ready = true;
  room.peers.set(1, peer);
  t.after(() => peer.close());
  peer.start();
  return { peer, room, socket, inputs, events };
}

test("lobby assignments map native wire identities to the chosen controller ports", (t) => {
  const { socket } = fixture(t, { manualStart: true, seats: [1, 0] });
  const modes = socket.packets.filter((p) => p.command === CMD.MODE);
  assert.equal(modes.length, 2);
  assert.equal(modes[0].data.readUInt32BE(4) & 0xffff, 0);
  assert.equal(modes[0].data.readUInt32BE(8), 2);
  assert.equal(modes[1].data.readUInt32BE(4) & 0xffff, 1);
  assert.equal(modes[1].data.readUInt32BE(8), 1);
});

test("prediction opt-in uses ordinary playing mode without self input echoes", (t) => {
  const { peer, socket } = fixture(t);
  assert.equal(peer.slave, false);
  const mode = socket.packets.find((p) => p.command === CMD.MODE);
  assert.equal(mode.data.readUInt32BE(4) & 0x20000000, 0);
  assert.equal(mode.data.readUInt32BE(4) >>> 30, 3);
  const inputs = socket.packets.filter((p) => p.command === CMD.INPUT);
  assert.deepEqual(
    inputs.map((p) => p.data.readUInt32BE(4)),
    [0],
  );
});

test("native input retains its frame and authenticated slot across startup", (t) => {
  const { peer, socket, inputs, events } = fixture(t);
  peer.command(CMD.INPUT, words(0, 1, 0));
  assert.deepEqual(inputs, []);
  peer.command(CMD.INPUT, words(1, 99, 16));
  assert.equal(peer.bootstrapped, true);
  assert.deepEqual(events, ["web-start", "input"]);
  assert.deepEqual(inputs, [{ frame: 0, player: 1, buttons: 16 }]);
  const load = socket.packets.find((p) => p.command === CMD.LOAD_STATE);
  assert.equal(load.data.readUInt32BE(0), 1);
  assert.equal(socket.packets.at(-1).command, CMD.STALL);
  peer.command(CMD.INPUT, words(2, 1, 32));
  peer.command(CMD.INPUT, words(3, 1, 64));
  assert.deepEqual(inputs.slice(1), [
    { frame: 1, player: 1, buttons: 32 },
    { frame: 2, player: 1, buttons: 64 },
  ]);
  peer.sendInput(2, 0, 128);
  assert.deepEqual(socket.packets.at(-1).data, words(3, 0, 128));
});

test("ordinary native input rejects gaps and ignores already accepted frames", (t) => {
  const { peer, inputs } = fixture(t);
  assert.throws(() => peer.command(CMD.INPUT, words(1, 1, 0)), /sequential/);
  peer.command(CMD.INPUT, words(0, 1, 0));
  peer.command(CMD.INPUT, words(1, 1, 16));
  peer.command(CMD.INPUT, words(1, 1, 32));
  assert.deepEqual(inputs, [{ frame: 0, player: 1, buttons: 16 }]);
  assert.throws(() => peer.command(CMD.INPUT, words(2, 1, 65536)), /joypad/);
  peer.command(CMD.INPUT, words(2, 1, 64));
  assert.equal(inputs.at(-1).frame, 1);
});

test("early native inputs wait for browser start and the queue is bounded", (t) => {
  const { peer, room, inputs } = fixture(t, { autoStart: false });
  for (let frame = 0; frame <= 120; frame++)
    peer.command(CMD.INPUT, words(frame, 1, frame));
  assert.equal(inputs.length, 0);
  peer.flushInputs();
  assert.equal(inputs.length, 0);
  assert.throws(
    () => peer.command(CMD.INPUT, words(121, 1, 0)),
    /startup input queue exceeded/,
  );
  room.running = true;
  peer.flushInputs();
  assert.equal(inputs.length, 120);
  assert.deepEqual(inputs.at(-1), { frame: 119, player: 1, buttons: 120 });
  peer.flushInputs();
  assert.equal(inputs.length, 120);
});

test("ordinary CRC waits for native serialization of its offset frame", (t) => {
  const { peer, socket } = fixture(t);
  peer.sendCrc(1, 123);
  peer.command(CMD.INPUT, words(0, 1, 0));
  peer.command(CMD.INPUT, words(1, 1, 0));
  assert.equal(socket.packets.filter((p) => p.command === CMD.CRC).length, 0);
  peer.command(CMD.INPUT, words(2, 1, 0));
  const crc = socket.packets.filter((p) => p.command === CMD.CRC);
  assert.equal(crc.length, 1);
  assert.deepEqual(crc[0].data, words(2, 123));
});

test("lockstep default retains native slave sampling and bootstrap echoes", (t) => {
  const { peer, socket, inputs } = fixture(t, { maxPrediction: 0 });
  assert.equal(peer.slave, true);
  const mode = socket.packets.find((p) => p.command === CMD.MODE);
  assert.equal(mode.data.readUInt32BE(4) & 0x20000000, 0x20000000);
  const echoes = socket.packets.filter((p) => p.command === CMD.INPUT);
  assert.deepEqual(
    echoes.map((p) => p.data.readUInt32BE(4)),
    [0, 1],
  );
  peer.command(CMD.INPUT, words(9, 1, 32));
  assert.equal(peer.buttons, 32);
  assert.deepEqual(inputs, []);
});
