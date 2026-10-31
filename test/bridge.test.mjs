import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { WebSocket } from "ws";
import { createBridge } from "../server.mjs";
import {
  CMD,
  Decoder,
  MAGIC,
  crc32,
  fixedString,
  infoPayload,
  packet,
  words,
  wrapState,
  statePayload,
  readStatePayload,
} from "../wire.mjs";

const ADMIN = "bridge-integration-test-secret-24";
const manifest = {
  system: "gb",
  coreName: "SameBoy",
  coreVersion: "1.0.4 c87d256",
  contentCrc: 0x12345678,
  stateSize: 128,
  players: 2,
  nativeAllowed: false,
  password: "",
};

test("rollback requires bounded opt-in and rejects startup-only calibration", async (t) => {
  const f = await fixture(t);
  for (const maxPrediction of [-1, 31, 0.5, "12"]) {
    const result = await f.api("/v1/rooms", { ...manifest, maxPrediction });
    assert.equal(result.status, 400);
  }
  const calibrated = await f.api("/v1/rooms", {
    ...manifest,
    nativeAllowed: true,
    nativeCalibration: "sameboy-v1",
    maxPrediction: 12,
  });
  assert.equal(calibrated.status, 400);
  assert.match(calibrated.data.error, /calibration/);
});

test("SNES reserves two pads and keeps a single host-owned cartridge save", async (t) => {
  const f = await fixture(t);
  const snes = {
    ...manifest,
    system: "snes",
    coreName: "Snes9x",
    maxPrediction: 12,
  };
  assert.equal((await f.api("/v1/rooms", { ...snes, players: 3 })).status, 400);
  const { data: room } = await f.api("/v1/rooms", snes);
  const host = await f.web(room.hostPath);
  await initial(host, Buffer.alloc(128), {
    sram: Buffer.from([1, 2, 3]).toString("base64"),
  });
  assert.deepEqual(f.bridge.rooms.get(room.id).sram, Buffer.from([1, 2, 3]));
  const { data: joined } = await f.api(`/v1/rooms/${room.id}/join`, {});
  const guest = await f.web(joined.peerPath);
  await guest.queue.next();
  await guest.queue.next();
  guest.send({ t: "battery", size: 1 });
  const closed = await host.queue.next();
  assert.equal(closed.t, "disconnect");
  assert.match(closed.message, /shared cartridge save/);
});

test("rollback start negotiates the window and confirmation cannot precede input", async (t) => {
  const f = await fixture(t);
  const { data: room } = await f.api("/v1/rooms", {
    ...manifest,
    maxPrediction: 12,
  });
  const host = await f.web(room.hostPath);
  await initial(host);
  const { data: joined } = await f.api(`/v1/rooms/${room.id}/join`, {});
  const guest = await f.web(joined.peerPath);
  await guest.queue.next();
  await guest.queue.next();
  guest.send({ t: "battery", size: 0 });
  guest.ws.send(Buffer.alloc(0));
  await host.queue.next();
  await host.queue.next();
  const revision = await initial(host, Buffer.alloc(128), { batteryPlayer: 1 });
  await guest.queue.next();
  await guest.queue.next();
  guest.send({ t: "ready", revision });
  assert.equal((await host.queue.next()).maxPrediction, 12);
  assert.equal((await guest.queue.next()).maxPrediction, 12);
  host.send({ t: "input", f: 0, b: 256 });
  assert.deepEqual(await guest.queue.next(), {
    t: "input",
    f: 0,
    b: 256,
    player: 0,
  });
  host.send({ t: "progress", f: 1, confirmed: 0 });
  host.send({ t: "progress", f: 1, confirmed: 1 });
  const closed = await host.queue.next();
  assert.equal(closed.t, "disconnect");
  assert.match(closed.message, /Invalid frame progress/);
});

class Queue {
  values = [];
  waits = [];
  push(value) {
    const waiter = this.waits.shift();
    if (waiter) waiter(value);
    else this.values.push(value);
  }
  next() {
    if (this.values.length) return Promise.resolve(this.values.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Message timed out")),
        3000,
      );
      this.waits.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }
}

async function fixture(t) {
  const bridge = await createBridge({
    adminToken: ADMIN,
    portStart: 0,
    portEnd: 0,
  });
  t.after(() => bridge.close());
  const base = `http://127.0.0.1:${bridge.address.port}`;
  async function api(path, data, method = data === undefined ? "GET" : "POST") {
    const response = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${ADMIN}`,
        "Content-Type": "application/json",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, data: await response.json() };
  }
  async function web(path) {
    const ws = new WebSocket(base.replace("http:", "ws:") + path);
    const queue = new Queue();
    ws.on("message", (bytes, binary) =>
      queue.push(binary ? bytes : JSON.parse(bytes.toString())),
    );
    ws.on("error", () => {});
    await once(ws, "open");
    const joined = await queue.next();
    return { ws, queue, joined, send: (data) => ws.send(JSON.stringify(data)) };
  }
  return { bridge, api, web, base };
}

async function initial(host, state = Buffer.alloc(128, 17), extra = {}) {
  host.send({ t: "state", f: 0, size: state.length, sram: "", ...extra });
  host.ws.send(state);
  const ready = await host.queue.next();
  assert.equal(ready.t, "state-ready");
  host.send({ t: "ready", revision: ready.revision });
  return ready.revision;
}

async function native(room, options = {}) {
  const socket = connect(room.tcpPort, "127.0.0.1");
  socket.on("error", () => {});
  const queue = new Queue();
  const decoder = new Decoder(
    (header) => queue.push(header),
    (command, payload) => queue.push({ command, payload }),
  );
  socket.on("data", (bytes) => decoder.push(bytes));
  await once(socket, "connect");
  const header = words(
    MAGIC,
    (8 << 15) | 8,
    options.compress ? 1 : 0,
    options.protocol ?? 7,
    5,
    42,
  );
  // Fragment the handshake to exercise the actual TCP stream parser.
  socket.write(header.subarray(0, 3));
  socket.write(header.subarray(3));
  const response = await queue.next();
  assert.equal(response.readUInt32BE(), MAGIC);
  socket.write(packet(CMD.NICK, fixedString("Desktop")));
  assert.equal((await queue.next()).command, CMD.NICK);
  if (room.password) {
    const salt = response
      .readUInt32BE(12)
      .toString(16)
      .toUpperCase()
      .padStart(8, "0");
    const hash = createHash("sha256")
      .update(salt + room.password)
      .digest("hex");
    socket.write(packet(CMD.PASSWORD, Buffer.from(hash)));
  }
  assert.equal((await queue.next()).command, CMD.INFO);
  socket.write(
    packet(CMD.INFO, infoPayload({ ...manifest, ...options.manifest })),
  );
  const sync = await queue.next();
  assert.equal(sync.command, CMD.SYNC);
  assert.equal(sync.payload.readUInt32BE(4), 1);
  assert.equal(sync.payload.readUInt32BE(8), 1);
  assert.equal(sync.payload.readUInt32BE(12), 1);
  if ((options.protocol ?? 7) >= 6) {
    assert.equal((await queue.next()).command, CMD.ALLOW_PAUSING);
    assert.equal((await queue.next()).command, CMD.LATENCY);
  }
  return { socket, queue, sync };
}

test("native clients wait for the browser's initial state and SRAM", async (t) => {
  const f = await fixture(t);
  const { data: room } = await f.api("/v1/rooms", {
    ...manifest,
    nativeAllowed: true,
  });
  const pending = native(room);
  pending.catch(() => {});
  const stored = f.bridge.rooms.get(room.id);
  const deadline = Date.now() + 1000;
  while (
    stored.peers.get(1)?.phase !== "waiting-state" &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(stored.peers.get(1)?.phase, "waiting-state");
  assert.equal(stored.peers.get(1)?.ready, false);
  assert.equal(stored.state, null);
  const host = await f.web(room.hostPath);
  const battery = Buffer.from([3, 9, 27]);
  await initial(host, Buffer.alloc(128, 17), {
    sram: battery.toString("base64"),
  });
  const desktop = await pending;
  assert.equal(stored.peers.get(1).phase, "connected");
  assert.deepEqual(desktop.sync.payload.subarray(-battery.length), battery);
});

test("CRC32 and protocol-7 core-state blocks follow native byte order", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  const raw = Buffer.from([1, 2, 3]);
  const state = wrapState(raw, 7);
  assert.equal(state.subarray(0, 8).toString("hex"), "4e4554504c415901");
  assert.equal(state.readUInt32LE(12), 3);
  assert.deepEqual(state.subarray(16, 19), raw);
  assert.equal(state.subarray(24, 28).toString(), "END ");
  assert.deepEqual(wrapState(raw, 5), raw);
});

test("room authorization, owner limits and single-use browser credentials", async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + "/v1/rooms")).status, 401);
  const created = await f.api("/v1/rooms", {
    ...manifest,
    owner: "user-1",
    romId: 12,
  });
  assert.equal(created.status, 201);
  assert.equal(
    (await f.api("/v1/rooms", { ...manifest, owner: "user-1" })).status,
    409,
  );
  const host = await f.web(created.data.hostPath);
  assert.equal(host.joined.player, 0);
  const repeated = new WebSocket(
    f.base.replace("http:", "ws:") + created.data.hostPath,
  );
  repeated.on("error", () => {});
  await once(repeated, "unexpected-response").then(([, response]) =>
    assert.equal(response.statusCode, 403),
  );
  repeated.terminate();
  await f.api(`/v1/rooms/${created.data.id}/join`, {});
  f.bridge.rooms.get(created.data.id).reservations.get(1).until =
    Date.now() - 1;
  const list = await f.api("/v1/rooms");
  assert.equal(list.data[0].current, 1);
  assert.equal(list.data[0].romId, 12);
  assert.equal(list.data[0].password, undefined);
  assert.equal(list.data[0].hostToken, undefined);
  assert.equal(
    (await f.api(`/v1/rooms/${created.data.id}`, undefined, "DELETE")).status,
    200,
  );
});

test("web guests import separate batteries before the start barrier", async (t) => {
  const f = await fixture(t);
  const { data: room } = await f.api("/v1/rooms", {
    ...manifest,
    system: "gba",
    players: 4,
  });
  const host = await f.web(room.hostPath);
  let revision = await initial(host);
  const guests = [];
  for (let player = 1; player < 4; player++) {
    const { data: joined } = await f.api(`/v1/rooms/${room.id}/join`, {});
    const guest = await f.web(joined.peerPath);
    assert.equal(guest.joined.player, player);
    const firstState = await guest.queue.next();
    assert.equal(firstState.t, "state");
    await guest.queue.next();
    guest.send({ t: "battery", size: 1 });
    guest.ws.send(Buffer.from([player]));
    assert.deepEqual(await host.queue.next(), {
      t: "battery",
      player,
      size: 1,
    });
    assert.deepEqual(await host.queue.next(), Buffer.from([player]));
    guests.push(guest);
    revision = await initial(host, Buffer.alloc(128, player), {
      batteryPlayer: player,
    });
    for (const current of guests) {
      const state = await current.queue.next();
      assert.equal(state.revision, revision);
      assert.equal((await current.queue.next())[0], player);
      current.send({ t: "ready", revision });
    }
  }
  assert.equal((await host.queue.next()).t, "start");
  for (const guest of guests)
    assert.equal((await guest.queue.next()).t, "start");
  host.send({ t: "input", f: 0, b: 1 });
  for (const guest of guests)
    assert.deepEqual(await guest.queue.next(), {
      t: "input",
      f: 0,
      b: 1,
      player: 0,
    });
  guests[1].send({ t: "input", f: 0, b: 128 });
  assert.deepEqual(await host.queue.next(), {
    t: "input",
    f: 0,
    b: 128,
    player: 2,
  });
  guests[0].ws.close();
  assert.equal((await host.queue.next()).t, "disconnect");
});

for (const protocol of [5, 6, 7])
  test(`RetroArch protocol ${protocol}: handshake, player mapping, input and state recovery`, async (t) => {
    const f = await fixture(t);
    const state = Buffer.alloc(128, 17);
    const { data: room } = await f.api("/v1/rooms", {
      ...manifest,
      nativeAllowed: true,
      password: "room-secret",
    });
    const host = await f.web(room.hostPath);
    await initial(host, state);
    const client = await native(room, { protocol, compress: protocol === 7 });
    t.after(() => client.socket.destroy());
    client.socket.write(packet(CMD.PLAY, words(0)));
    const mode = await client.queue.next();
    assert.equal(mode.command, CMD.MODE);
    assert.equal(mode.payload.readUInt32BE(4), 0xe0000001);
    assert.equal(mode.payload.readUInt32BE(8), 2);
    for (let player = 0; player < 2; player++) {
      const bootstrap = await client.queue.next();
      assert.equal(bootstrap.command, CMD.INPUT);
      assert.deepEqual(bootstrap.payload, words(0, player, 0));
    }
    client.socket.write(packet(CMD.REQUEST_STATE)); // Achievement initialization, before the epoch barrier.
    client.socket.write(packet(CMD.INPUT, words(1, 31, 128)));
    const load = await client.queue.next();
    assert.equal(load.command, CMD.LOAD_STATE);
    assert.equal(load.payload.readUInt32BE(0), 1);
    const raw =
      protocol === 7
        ? inflateSync(load.payload.subarray(8))
        : load.payload.subarray(8);
    assert.deepEqual(raw, wrapState(state, protocol));
    assert.equal((await client.queue.next()).command, CMD.STALL);
    assert.equal((await host.queue.next()).t, "start");
    host.send({ t: "input", f: 0, b: 256 });
    const slaveInput = await client.queue.next();
    assert.deepEqual(slaveInput.payload, words(1, 1, 128));
    const input = await client.queue.next();
    assert.equal(input.command, CMD.INPUT);
    assert.deepEqual(input.payload, words(1, 0, 256));
    assert.deepEqual(await host.queue.next(), {
      t: "input",
      f: 0,
      b: 128,
      player: 1,
    });
    host.send({ t: "progress", f: 1, confirmed: 1 });
    host.send({ t: "crc", f: 1, crc: crc32(state) });
    assert.equal(f.bridge.rooms.get(room.id).peers.get(1).checksSent, 0);
    client.socket.write(packet(CMD.INPUT, words(2, 31, 128)));
    const checkpoint = await client.queue.next();
    assert.equal(checkpoint.command, CMD.CRC);
    assert.deepEqual(checkpoint.payload, words(2, crc32(state)));
    client.socket.write(packet(CMD.REQUEST_STATE));
    assert.deepEqual(await host.queue.next(), { t: "state-request", f: 1 });
    host.send({ t: "state", f: 1, size: state.length });
    host.ws.send(state);
    assert.equal((await client.queue.next()).command, CMD.LOAD_STATE);
    assert.equal((await host.queue.next()).t, "state-ready");
    client.socket.write(packet(CMD.PAUSE, fixedString("Desktop")));
    assert.deepEqual(await host.queue.next(), { t: "pause", paused: true });
    client.socket.write(packet(CMD.RESUME));
    assert.deepEqual(await host.queue.next(), { t: "pause", paused: false });
  });

test("a web-only room never allocates a native listener", async (t) => {
  const f = await fixture(t);
  const { data: room } = await f.api("/v1/rooms", manifest);
  assert.equal(room.tcpPort, null);
  assert.equal(f.bridge.rooms.get(room.id).listener, undefined);
});

test("framing rejects oversized packets before allocation", () => {
  const decoder = new Decoder(
    () => {},
    () => assert.fail("Oversized command delivered"),
  );
  assert.throws(
    () =>
      decoder.push(
        Buffer.concat([Buffer.alloc(24), words(CMD.INPUT, 0xffffffff)]),
      ),
    /maximum/,
  );
});

test("concurrent native room creation preserves the owner limit", async (t) => {
  const f = await fixture(t);
  const results = await Promise.all([
    f.api("/v1/rooms", {
      ...manifest,
      nativeAllowed: true,
      owner: "same-owner",
    }),
    f.api("/v1/rooms", {
      ...manifest,
      nativeAllowed: true,
      owner: "same-owner",
    }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  assert.equal(f.bridge.rooms.size, 1);
});

test("checkpoint history stays bounded across reordered peers and rejects old frames", async (t) => {
  const f = await fixture(t);
  const { data } = await f.api("/v1/rooms", manifest);
  const room = f.bridge.rooms.get(data.id);
  room.running = true;
  const host = { player: 0, confirmed: 1200 };
  const guest = { player: 1, confirmed: 1200 };
  for (let frame = 0; frame <= 1200; frame++) {
    room.checksum(host, { f: frame, crc: frame });
    assert.ok(room.crcs.size <= 601);
  }
  assert.equal(Math.min(...room.crcs.keys()), 600);
  assert.throws(
    () => room.checksum(host, { f: 1199, crc: 1199 }),
    /Invalid checkpoint/,
  );
  assert.throws(
    () => room.checksum(guest, { f: 599, crc: 599 }),
    /Invalid checkpoint/,
  );
  room.checksum(guest, { f: 600, crc: 600 });
  room.checksum(guest, { f: 600, crc: 600 });
  assert.throws(
    () => room.checksum(guest, { f: 600, crc: 1 }),
    /Conflicting checkpoint/,
  );
  assert.equal(room.crcs.size, 601);
});

test("a mismatched web checksum closes the room instead of hiding divergence", async (t) => {
  const f = await fixture(t);
  const { data: room } = await f.api("/v1/rooms", manifest);
  const host = await f.web(room.hostPath);
  await initial(host);
  const { data: joined } = await f.api(`/v1/rooms/${room.id}/join`, {});
  const guest = await f.web(joined.peerPath);
  await guest.queue.next();
  await guest.queue.next();
  guest.send({ t: "battery", size: 0 });
  guest.ws.send(Buffer.alloc(0));
  await host.queue.next();
  await host.queue.next();
  const revision = await initial(host, Buffer.alloc(128), { batteryPlayer: 1 });
  await guest.queue.next();
  await guest.queue.next();
  guest.send({ t: "ready", revision });
  await host.queue.next();
  await guest.queue.next();
  host.send({ t: "crc", f: 0, crc: 1 });
  guest.send({ t: "crc", f: 0, crc: 2 });
  const closed = await host.queue.next();
  assert.equal(closed.t, "disconnect");
  assert.match(closed.message, /State mismatch at frame 0/);
  assert.equal(f.bridge.rooms.size, 0);
});

test("SameBoy calibration validates two native samples before restoring the latest host state", async (t) => {
  const f = await fixture(t);
  const original = Buffer.alloc(128, 17),
    first = Buffer.alloc(128, 23),
    second = Buffer.alloc(128, 24);
  const { data: room } = await f.api("/v1/rooms", {
    ...manifest,
    nativeAllowed: true,
    nativeCalibration: "sameboy-v1",
  });
  const host = await f.web(room.hostPath);
  await initial(host, original);
  const client = await native(room, { protocol: 7, compress: true });
  t.after(() => client.socket.destroy());
  client.socket.write(packet(CMD.PLAY, words(0)));
  assert.equal((await client.queue.next()).command, CMD.REQUEST_STATE);
  assert.equal((await client.queue.next()).command, CMD.MODE);
  for (let player = 0; player < 2; player++)
    assert.deepEqual((await client.queue.next()).payload, words(0, player, 0));
  client.socket.write(packet(CMD.LOAD_STATE, statePayload(1, first, 7, true)));
  assert.deepEqual(await host.queue.next(), {
    t: "native-calibration",
    player: 1,
    stage: 0,
    size: 128,
  });
  assert.deepEqual(await host.queue.next(), first);
  assert.equal((await client.queue.next()).command, CMD.REQUEST_STATE);
  for (let player = 0; player < 2; player++)
    assert.deepEqual((await client.queue.next()).payload, words(1, player, 0));
  client.socket.write(packet(CMD.LOAD_STATE, statePayload(2, second, 7, true)));
  assert.deepEqual(await host.queue.next(), {
    t: "native-calibration",
    player: 1,
    stage: 1,
    size: 128,
  });
  assert.deepEqual(await host.queue.next(), second);
  assert.equal(f.bridge.rooms.get(room.id).running, undefined);
  host.send({ t: "native-ready" });
  const restored = await client.queue.next();
  assert.equal(restored.command, CMD.LOAD_STATE);
  assert.deepEqual(readStatePayload(restored.payload, 7, true, 128), {
    frame: 2,
    state: original,
  });
  assert.equal((await client.queue.next()).command, CMD.STALL);
  assert.equal((await host.queue.next()).t, "start");
  host.send({ t: "input", f: 0, b: 256 });
  assert.deepEqual((await client.queue.next()).payload, words(2, 1, 0));
  assert.deepEqual((await client.queue.next()).payload, words(2, 0, 256));
});

test("native state parsing rejects malformed envelopes and wrong raw sizes", () => {
  const state = Buffer.alloc(128, 3);
  assert.deepEqual(
    readStatePayload(statePayload(2, state, 7, true), 7, true, 128),
    { frame: 2, state },
  );
  const malformed = statePayload(2, state, 7, false);
  malformed.writeUInt32LE(0xffffffff, 20);
  assert.throws(() => readStatePayload(malformed, 7, false, 128), /block/);
  assert.throws(
    () => readStatePayload(statePayload(2, state, 5, false), 5, false, 127),
    /size/,
  );
});
