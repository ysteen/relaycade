import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { NativePeer } from "../native.mjs";
import { CMD, words, statePayload } from "../wire.mjs";

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
    lobbyFrames = 0,
  } = {},
) {
  const socket = new Socket();
  const inputs = [];
  const events = [];
  const room = {
    manifest: { maxPrediction, stateSize: 128, manualStart, players: 2 },
    seats,
    lobby() {},
    password: "",
    state: Buffer.alloc(128, 7),
    peers: new Map([
      [0, { player: 0, nickname: "Web", kind: "web", frame: 0, playing: true }],
    ]),
    host: 0,
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
      peer.playing = true;
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
  for (let frame = 0; frame < lobbyFrames; frame++) peer.keepLobbyAlive();
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

test("a native snapshot used for web rejoin retains its logical frame without restarting", (t) => {
  const { peer, room, socket } = fixture(t, {
    manualStart: true,
    lobbyFrames: 7,
  });
  const snapshots = [];
  room.completeResume = (...args) => snapshots.push(args);
  peer.requestResumeSource("web-rejoin");
  assert.equal(socket.packets.at(-1).command, CMD.REQUEST_STATE);
  const bytes = Buffer.alloc(128, 19);
  peer.command(
    CMD.LOAD_STATE,
    statePayload(peer.frameOffset + 120, bytes, peer.protocol, false),
  );
  assert.deepEqual(snapshots, [[peer, "web-rejoin", 120, bytes]]);
  assert.equal(peer.resumeSourceId, null);
  assert.equal(peer.restarting, undefined);
});

test("native waiting frames stay private and start rebases to the host state", (t) => {
  const { peer, room, socket, inputs } = fixture(t, {
    manualStart: true,
    seats: [1, 0],
    lobbyFrames: 7,
  });
  const idle = socket.packets.slice(0, 7);
  assert(idle.every((entry) => entry.command === CMD.INPUT));
  assert.deepEqual(
    idle.map((entry) =>
      [...Array(3)].map((_, i) => entry.data.readUInt32BE(i * 4)),
    ),
    Array.from({ length: 7 }, (_, frame) => [frame, 0, 0]),
  );
  assert.deepEqual(inputs, []);
  assert.equal(room.running, false);
  const modes = socket.packets.filter((entry) => entry.command === CMD.MODE);
  assert(modes.every((entry) => entry.data.readUInt32BE(0) === 7));
  const before = socket.packets.length;
  peer.keepLobbyAlive();
  assert.equal(socket.packets.length, before, "No idle frames during startup");
  peer.command(CMD.INPUT, words(7, 1, 0));
  peer.command(CMD.INPUT, words(8, 1, 16));
  assert.deepEqual(inputs, [{ frame: 0, player: 1, buttons: 16 }]);
  const load = socket.packets.find((entry) => entry.command === CMD.LOAD_STATE);
  assert.equal(load.data.readUInt32BE(0), 8);
  assert.deepEqual(load.data.subarray(24, 152), room.state);
  peer.playing = true;
  const activePackets = socket.packets.length;
  peer.keepLobbyAlive();
  assert.equal(socket.packets.length, activePackets);
  peer.sendInput(1, 0, 32);
  assert.deepEqual(socket.packets.at(-1).data, words(9, 0, 32));
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

test("an active native peer still fails on an excessive pending verification backlog", (t) => {
  const { peer } = fixture(t);
  peer.command(CMD.INPUT, words(0, 1, 0));
  peer.command(CMD.INPUT, words(1, 1, 0));
  assert(peer.playing);
  for (let frame = 60; frame <= 960; frame += 60) peer.sendCrc(frame, 123);
  assert.equal(peer.pendingChecks.size, 16);
  assert.throws(
    () => peer.sendCrc(1020, 123),
    /Native peer fell behind the verification window/,
  );
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

test("restart drains old native input before rebasing the existing connection", (t) => {
  const { peer, room, socket, inputs } = fixture(t, { manualStart: true });
  peer.command(CMD.INPUT, words(0, 1, 0));
  peer.command(CMD.INPUT, words(1, 1, 8));
  peer.sendInput(0, 0, 0);
  room.running = false;
  peer.probe = { sent: performance.now() };
  let ready = 0;
  room.maybeStart = () => {
    ready++;
  };
  peer.prepareRestart();
  assert.equal(socket.packets.at(-1).command, CMD.PING);
  assert.notEqual(
    socket.packets.at(-2).command,
    CMD.STALL,
    "Restart must not suppress RetroArch's post-frame state-load advance",
  );
  peer.command(CMD.INPUT, words(5, 1, 32));
  assert.equal(inputs.length, 1);
  peer.command(CMD.PONG, Buffer.alloc(0));
  assert.equal(ready, 0);
  peer.command(CMD.PONG, Buffer.alloc(0));
  assert.equal(ready, 1);
  assert(peer.restartReady);
  const before = socket.packets.length;
  room.running = true;
  peer.finishStart();
  peer.flushInputs();
  const restart = socket.packets.slice(before);
  assert.deepEqual(
    restart
      .filter((packet) => packet.command === CMD.NOINPUT)
      .map((packet) => packet.data.readUInt32BE(0)),
    [2, 3, 4, 5],
  );
  assert.equal(
    restart
      .find((packet) => packet.command === CMD.LOAD_STATE)
      .data.readUInt32BE(0),
    6,
  );
  assert.equal(restart.at(-1).command, CMD.LOAD_STATE);
  assert(!restart.some((packet) => packet.command === CMD.STALL));
  assert.equal(peer.frameOffset, 6);
  peer.command(CMD.INPUT, words(5, 1, 128));
  assert.equal(inputs.length, 1);
  peer.command(CMD.INPUT, words(6, 1, 64));
  assert.deepEqual(inputs.at(-1), { frame: 0, player: 1, buttons: 64 });
  assert(!socket.destroyed);
});

function pacingFixture(t) {
  const f = fixture(t, { manualStart: true, seats: [1, 0], lobbyFrames: 7 });
  f.peer.command(CMD.INPUT, words(7, 1, 0));
  f.peer.command(CMD.INPUT, words(8, 1, 0));
  f.host = f.room.peers.get(0);
  f.host.frame = 1;
  f.socket.packets.length = 0;
  return f;
}

function nativeFrames(peer, end) {
  while (peer.nextFrame < end)
    peer.command(
      CMD.INPUT,
      words(peer.nextWireFrame, peer.wirePlayer(peer.player), peer.nextFrame),
    );
}

for (const nativePlayer of [0, 1])
  test(`native pacing preserves input, CRC and wire frames with native member ${nativePlayer}`, (t) => {
    const { peer, host, room, socket, inputs } = pacingFixture(t);
    if (nativePlayer === 0) {
      peer.player = 0;
      peer.serverPlayer = 1;
      host.player = room.host = 1;
      room.peers = new Map([
        [1, host],
        [0, peer],
      ]);
    }
    const logs = [];
    room.bridge = { log: (event, fields) => logs.push({ event, ...fields }) };
    peer.pace(host, 0);
    nativeFrames(peer, 129);
    host.frame = 121;
    peer.pace(host, 2000);
    assert.deepEqual(socket.packets, [{ command: CMD.STALL, data: words(6) }]);
    assert.equal(peer.frameOffset, 8);
    assert.equal(peer.nextWireFrame, 137);
    assert.equal(logs[0].event, "native-paced");
    assert.equal(logs[0].leadFrames, 8);
    assert.equal(logs[0].stallFrames, 6);
    assert.equal(logs[0].hostPlayer, host.player);
    nativeFrames(peer, 130);
    assert.deepEqual(inputs.at(-1), {
      frame: 129,
      player: nativePlayer,
      buttons: 129,
    });
    peer.sendInput(121, host.player, 32);
    assert.deepEqual(socket.packets.at(-1), {
      command: CMD.INPUT,
      data: words(129, 0, 32),
    });
    peer.sendCrc(121, 456);
    assert.deepEqual(socket.packets.at(-1), {
      command: CMD.CRC,
      data: words(129, 456),
    });
    assert.equal(peer.pendingChecks.size, 0);
    assert(!socket.destroyed);
  });

test("native pacing tolerates small leads and respects frame and time limits", (t) => {
  const { peer, host, socket } = pacingFixture(t);
  peer.pace(host, 0);
  for (const lead of [-2, 0, 2, 3]) {
    host.frame = 121;
    peer.nextFrame = host.frame + lead;
    peer.pace(host, 2000);
    assert.equal(socket.packets.length, 0);
  }
  peer.nextFrame = 125;
  peer.pace(host, 2000);
  assert.deepEqual(socket.packets.at(-1).data, words(2));
  for (const [frame, now] of [
    [121, 4000],
    [240, 4000],
    [241, 3999],
  ]) {
    host.frame = frame;
    peer.nextFrame = frame + 80;
    peer.pace(host, now);
    assert.equal(socket.packets.length, 1);
  }
  peer.pace(host, 4000);
  assert.deepEqual(socket.packets.at(-1).data, words(60));
  assert.equal(socket.packets.length, 2);
});

test("native pacing skips pauses, startup, restart, lockstep and inactive hosts", (t) => {
  const { peer, host, room, socket } = pacingFixture(t);
  const cases = [
    [room, "running", false],
    [room, "paused", true],
    [room, "host", null],
    [peer, "playing", false],
    [peer, "nativeInputsReady", false],
    [peer, "bootstrapping", true],
    [peer, "restarting", true],
    [peer, "slave", true],
    [peer, "phase", "waiting-state"],
    [host, "playing", false],
    [host, "kind", "native"],
  ];
  for (const [object, key, value] of cases) {
    host.frame = 1;
    peer.pace(host, 0);
    host.frame = 121;
    peer.nextFrame = 129;
    const saved = object[key];
    object[key] = value;
    peer.pace(host, 2000);
    assert.equal(socket.packets.length, 0, key);
    assert.equal(peer.pacing, null, key);
    object[key] = saved;
  }
  peer.pace(undefined, 4000);
  room.peers.delete(host.player);
  peer.pace(host, 4000);
  assert.equal(socket.packets.length, 0);
});

test("native pacing gives a replacement host and a new game time to settle", (t) => {
  const { peer, host, room, socket } = pacingFixture(t);
  peer.pace(host, 0);
  host.frame = 121;
  peer.nextFrame = 129;
  peer.pace(host, 2000);
  const replacement = { ...host };
  room.peers.set(host.player, replacement);
  replacement.frame = 241;
  peer.nextFrame = 249;
  peer.pace(replacement, 4000);
  assert.equal(socket.packets.length, 1);
  replacement.frame = 361;
  peer.nextFrame = 369;
  peer.pace(replacement, 6000);
  assert.equal(socket.packets.length, 2);
  peer.finishStart();
  assert.equal(peer.pacing, null);
  const before = socket.packets.length;
  replacement.frame = 1;
  peer.nextFrame = 9;
  peer.pace(replacement, 8000);
  assert.equal(socket.packets.length, before);
  replacement.frame = 121;
  peer.nextFrame = 129;
  peer.pace(replacement, 10000);
  assert.equal(socket.packets.length, before + 1);
});

test("bounded stalls converge an eight-frame lead while retaining every sampled input", (t) => {
  const { peer, host, socket, inputs } = pacingFixture(t);
  nativeFrames(peer, 9);
  peer.pace(host, 0);
  let waiting = 0;
  let requests = 0;
  for (let tick = 1; tick <= 600; tick++) {
    if (waiting) waiting--;
    else nativeFrames(peer, peer.nextFrame + 1);
    host.frame++;
    peer.pace(host, tick * (1000 / 59.7275));
    for (const { command, data } of socket.packets.splice(0)) {
      assert.equal(command, CMD.STALL);
      waiting = data.readUInt32BE(0);
      requests++;
    }
  }
  assert.equal(peer.nextFrame - host.frame, 2);
  assert.equal(requests, 1);
  assert.equal(inputs.length, peer.nextFrame);
  for (const [frame, input] of inputs.entries())
    assert.deepEqual(input, { frame, player: 1, buttons: frame });
});
