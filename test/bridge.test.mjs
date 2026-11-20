import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { WebSocket } from "ws";
import { createBridge } from "../server.mjs";
import {
  CMD,
  Decoder,
  MAGIC,
  MAX_STATE,
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

async function fixture(t, { logger = () => {} } = {}) {
  const bridge = await createBridge({
    adminToken: ADMIN,
    portStart: 0,
    portEnd: 0,
    logger,
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

test("native diagnostics record mismatch phases without credentials or nicknames", async (t) => {
  const entries = [];
  const f = await fixture(t, { logger: (entry) => entries.push(entry) });
  const nickname = "private-test-nickname";
  for (const password of ["", "private-test-room-password"]) {
    const { data: room } = await f.api("/v1/rooms", {
      ...manifest,
      nativeAllowed: true,
      password,
    });
    const socket = connect(room.tcpPort, "127.0.0.1");
    socket.on("error", () => {});
    socket.on("data", () => {});
    t.after(() => socket.destroy());
    await once(socket, "connect");
    const closed = once(socket, "close");
    socket.write(
      Buffer.concat([
        words(MAGIC, (8 << 15) | 8, 0, 7, 5, 0),
        packet(CMD.NICK, fixedString(nickname)),
        password
          ? packet(CMD.PASSWORD, Buffer.alloc(64, 48))
          : packet(
              CMD.INFO,
              infoPayload({ ...manifest, coreVersion: "wrong-version" }),
            ),
      ]),
    );
    await closed;
  }
  const errors = entries.filter((entry) => entry.event === "native-error");
  assert.deepEqual(
    errors.map(({ phase }) => phase),
    ["info", "password"],
  );
  assert.match(errors[0].reason, /Core name or version/);
  assert.equal(errors[1].reason, "Incorrect room password");
  assert(
    entries.some(
      (entry) =>
        entry.event === "native-core-info" &&
        entry.coreVersion === "wrong-version",
    ),
  );
  assert(entries.some((entry) => entry.event === "native-closed"));
  assert(!JSON.stringify(entries).includes(nickname));
  assert(!JSON.stringify(entries).includes("private-test-room-password"));
});

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
  if (options.denied) {
    assert.equal((await queue.next()).command, CMD.NAK);
    socket.destroy();
    return { socket, queue };
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

const preparedManifest = {
  ...manifest,
  romId: 11,
  owner: "host",
  manualStart: true,
  nativeAllowed: true,
  nativeAuth: true,
  cartridges: [0, 1].map(() => ({
    romId: 11,
    sha256: "a".repeat(64),
    size: 32768,
    crc32: manifest.contentCrc,
  })),
};

test("native credentials cannot expose prepared SRAM or initial saves to a replacement account", async (t) => {
  const f = await fixture(t);
  const { data: room } = await f.api("/v1/rooms", {
    ...preparedManifest,
    nativeAuthority: true,
    maxPrediction: 12,
  });
  await f.web(room.hostPath);
  const stored = f.bridge.rooms.get(room.id);
  stored.seats[0] = 0;
  stored.state = Buffer.alloc(128, 22);
  stored.sram = Buffer.from([22]);
  async function prepare(owner) {
    const result = await f.api(`/v1/rooms/${room.id}/native`, {
      owner,
      romId: 11,
      clientPlatform: "windows-x86_64",
      battery: "Fg==",
    });
    assert.equal(result.status, 201);
    const route = `/v1/rooms/${room.id}/native/${result.data.credential}`;
    assert.equal((await f.api(route, { seat: 1 }, "PATCH")).status, 200);
    return { ...result.data, route };
  }
  const original = await prepare("original-owner");
  const initial = (await f.api(original.route)).data;
  assert.equal(initial.pending, false);
  assert.equal(initial.initialBatteries[1], "Fg==");
  await f.api(original.route, undefined, "DELETE");
  const stranger = await prepare("new-owner");
  const blocked = (await f.api(stranger.route)).data;
  assert.equal(blocked.pending, true);
  assert.equal(blocked.initialBatteries, undefined);
  assert.equal(stored.metadata().saveOwners[1].owner, "original-owner");
  await native(
    { ...room, password: stranger.nativePassword },
    { denied: true },
  );
  assert.equal(stored.peers.has(1), false);
  assert.equal(stored.closed, false);
  await f.api(stranger.route, undefined, "DELETE");
  const returning = await prepare("original-owner");
  assert.equal(returning.player, original.player);
  assert.equal((await f.api(returning.route)).data.pending, false);
  const client = await native({ ...room, password: returning.nativePassword });
  t.after(() => client.socket.destroy());
  assert.equal(stored.peers.get(1).owner, "original-owner");
});

test("native authority starts two RetroArch clients without a web core and transfers hosting", async (t) => {
  const f = await fixture(t);
  const settings = {
    ...preparedManifest,
    system: "gba",
    coreName: "mGBA Splitscreen",
    coreVersion: "test",
    stateSize: 1,
    maxPrediction: 12,
    collectCartridges: true,
    nativeAuthority: true,
  };
  const { data: room } = await f.api("/v1/rooms", settings);
  const stored = f.bridge.rooms.get(room.id);
  const host = await f.web(room.hostPath);
  const { data: joined } = await f.api(`/v1/rooms/${room.id}/join`, {
    owner: "guest",
    romId: 11,
    cartridge: settings.cartridges[1],
  });
  await f.web(joined.peerPath);
  async function control(owner, message) {
    const result = await f.api(`/v1/rooms/${room.id}/control`, {
      owner,
      ...message,
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  }
  await control("host", { t: "assign", player: 0, seat: 0 });
  await control("guest", { t: "assign", player: 1, seat: 1 });
  const preparations = [];
  for (const [player, owner] of ["host", "guest"].entries()) {
    const result = await f.api(`/v1/rooms/${room.id}/native`, {
      owner,
      romId: 11,
      clientPlatform: "windows-x86_64",
      cartridge: settings.cartridges[player],
      battery: Buffer.from([player + 1]).toString("base64"),
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    preparations.push(result.data);
  }
  assert.notEqual(host.ws.readyState, WebSocket.OPEN);
  assert.equal(stored.peers.size, 0);
  assert.equal(stored.closed, false);
  assert.equal(stored.host, 0);
  assert.equal(stored.metadata().canStart, true);
  assert.equal(
    (
      await f.api(`/v1/rooms/${room.id}/control`, {
        owner: "guest",
        t: "start-request",
      })
    ).status,
    409,
  );
  await control("host", { t: "start-request" });
  assert.equal(stored.contentPrepared, true);
  const launched = await f.api(
    `/v1/rooms/${room.id}/native/${preparations[0].credential}`,
  );
  assert.equal(launched.data.pending, false);
  assert.deepEqual(launched.data.initialBatteries, ["AQ==", "Ag=="]);
  const clients = [];
  for (const preparation of preparations) {
    const client = await native(
      { ...room, password: preparation.nativePassword },
      { manifest: settings },
    );
    t.after(() => client.socket.destroy());
    client.socket.setNoDelay(true);
    client.socket.write(packet(CMD.PLAY, words(0)));
    assert.equal((await client.queue.next()).command, CMD.INPUT);
    clients.push(client);
  }
  assert.equal(stored.state, null);
  assert.equal((await clients[0].queue.next()).command, CMD.REQUEST_STATE);
  for (let i = 0; i < 2; i++)
    assert.equal((await clients[0].queue.next()).command, CMD.INPUT);
  const seed = Buffer.alloc(128, 42);
  clients[0].socket.write(
    packet(CMD.LOAD_STATE, statePayload(3, seed, 7, false)),
  );
  for (const client of clients) {
    let frame;
    do frame = await client.queue.next();
    while (frame.command === CMD.MODE);
    assert.equal(frame.command, CMD.INPUT);
    const f0 = frame.payload.readUInt32BE(0);
    client.socket.write(
      Buffer.concat([
        packet(CMD.INPUT, words(f0, 1, 0)),
        packet(CMD.INPUT, words(f0 + 1, 1, 0)),
      ]),
    );
  }
  for (const client of clients) {
    const load = await client.queue.next();
    assert.equal(load.command, CMD.LOAD_STATE);
    assert.deepEqual(readStatePayload(load.payload, 7, false, 128).state, seed);
    assert.equal((await client.queue.next()).command, CMD.STALL);
  }
  assert.equal(stored.manifest.stateSize, 128);
  assert.equal(stored.running, true);
  assert.equal(stored.host, 0);
  async function nativeMessage(client, command) {
    for (;;) {
      const message = await client.queue.next();
      assert.notEqual(message.command, CMD.NAK);
      if (message.command === command) return message;
    }
  }
  for (let frame = 1; frame <= 90; frame++) {
    for (const [player, client] of clients.entries()) {
      client.socket.write(
        Buffer.concat([
          packet(
            CMD.INPUT,
            words(stored.peers.get(player).frameOffset + frame, 1, player + 1),
          ),
          packet(CMD.PING),
        ]),
      );
      await nativeMessage(client, CMD.PONG);
    }
  }
  assert.equal(stored.progress, 90);
  assert(stored.peers.get(1).playing);
  const authority = stored.peers.get(0);
  authority.requestCheckpoint();
  await nativeMessage(clients[0], CMD.REQUEST_STATE);
  clients[0].socket.write(
    packet(
      CMD.LOAD_STATE,
      statePayload(authority.frameOffset + 91, seed, 7, false),
    ),
  );
  const check = await nativeMessage(clients[1], CMD.LOAD_STATE);
  assert.deepEqual(readStatePayload(check.payload, 7, false, 128), {
    frame: stored.peers.get(1).frameOffset + 91,
    state: seed,
  });
  assert.equal(stored.peers.get(1).statesRelayed, 1);
  assert.equal(stored.peers.get(1).checksSent, 0);
  await f.api(`/v1/rooms/${room.id}/leave`, { owner: "host" });
  assert.equal(stored.host, 1);
  assert.equal(stored.progress, 90);
  const guest = await f.api(`/v1/rooms/${room.id}/join`, {
    owner: "host",
    romId: 11,
    cartridge: settings.cartridges[0],
  });
  const web = await f.web(guest.data.peerPath);
  await control("host", { t: "assign", player: 0, seat: 0 });
  web.send({ t: "game-open", generation: stored.generation });
  web.send({
    t: "content-ready",
    generation: stored.generation,
    size: 128,
    contentCrc: settings.contentCrc,
    resume: true,
  });
  await nativeMessage(clients[1], CMD.REQUEST_STATE);
  clients[1].socket.write(
    packet(
      CMD.LOAD_STATE,
      statePayload(stored.peers.get(1).frameOffset + 90, seed, 7, false),
    ),
  );
  let prepared;
  do prepared = await web.queue.next();
  while (prepared.t !== "prepare");
  assert.equal(prepared.nativeState, true);
  assert.equal(prepared.restarting, true);
  assert.equal(prepared.generation, stored.generation);
  let transfer;
  do transfer = await web.queue.next();
  while (transfer.t !== "state");
  assert.equal(transfer.f, 0);
  assert.deepEqual(await web.queue.next(), seed);
  const authorityAfterResume = stored.peers.get(1);
  assert(authorityAfterResume.restarting);
  assert.equal(stored.running, false);
  await nativeMessage(clients[1], CMD.PING);
  for (let pong = 0; pong < authorityAfterResume.restartPongs; pong++)
    clients[1].socket.write(packet(CMD.PONG));
  web.send({
    t: "ready",
    revision: transfer.revision,
    generation: stored.generation,
  });
  const restored = await nativeMessage(clients[1], CMD.LOAD_STATE);
  assert.deepEqual(
    readStatePayload(restored.payload, 7, false, 128).state,
    seed,
  );
  let started;
  do started = await web.queue.next();
  while (started.t !== "start");
  assert.equal(started.generation, stored.generation);
  assert.equal(stored.running, true);
  assert.equal(stored.host, 1);
  await f.api(`/v1/rooms/${room.id}/leave`, { owner: "guest" });
  assert.equal(stored.host, 0);
  assert.equal(stored.peers.get(0).kind, "web");
  assert.equal(stored.running, true);
});

test("removing a native reservation restores the web game host", async (t) => {
  const f = await fixture(t);
  const { data: room } = await f.api("/v1/rooms", {
    ...preparedManifest,
    nativeAuthority: true,
    maxPrediction: 12,
  });
  const stored = f.bridge.rooms.get(room.id);
  await f.web(room.hostPath);
  for (const removal of ["cancel", "expire", "leave", "kick"]) {
    const { data: reservation, status } = await f.api(
      `/v1/rooms/${room.id}/native`,
      {
        owner: "native",
        romId: 11,
        battery: "",
        clientPlatform: "windows-x86_64",
      },
    );
    assert.equal(status, 201, JSON.stringify(reservation));
    assert.equal(stored.host, 1);
    assert.equal(stored.roomHost, 0);
    if (removal === "cancel") {
      const response = await f.api(
        `/v1/rooms/${room.id}/native/${reservation.credential}`,
        undefined,
        "DELETE",
      );
      assert.equal(response.status, 200);
    } else if (removal === "expire") {
      stored.reservations.get(1).until = Date.now() - 1;
      stored.expireReservations();
    } else if (removal === "leave") {
      const response = await f.api(`/v1/rooms/${room.id}/leave`, {
        owner: "native",
      });
      assert.equal(response.status, 200);
    } else {
      const response = await f.api(`/v1/rooms/${room.id}/control`, {
        owner: "host",
        t: "kick",
        player: 1,
      });
      assert.equal(response.status, 200);
    }
    assert.equal(stored.host, 0);
    assert.equal(stored.roomHost, 0);
    assert.equal(stored.manifest.owner, "host");
  }
});

test("the room creator starts the game with a native guest as state authority", async (t) => {
  const f = await fixture(t);
  const settings = {
    ...preparedManifest,
    nativeAuthority: true,
    maxPrediction: 12,
  };
  const { data: room } = await f.api("/v1/rooms", settings);
  const stored = f.bridge.rooms.get(room.id);
  const web = await f.web(room.hostPath);
  const preparation = await f.api(`/v1/rooms/${room.id}/native`, {
    owner: "native",
    romId: 11,
    battery: "Ag==",
    clientPlatform: "windows-x86_64",
  });
  assert.equal(preparation.status, 201);
  const client = await native(
    { ...room, password: preparation.data.nativePassword },
    { manifest: settings },
  );
  t.after(() => client.socket.destroy());
  client.socket.write(packet(CMD.PLAY, words(0)));
  assert.equal((await client.queue.next()).command, CMD.INPUT);
  assert.equal(stored.host, 1);
  assert.equal(stored.metadata().roomHost, 0);
  assert.equal(stored.metadata().owner, "host");
  assert.equal(stored.state, null);
  const control = (owner, action) =>
    f.api(`/v1/rooms/${room.id}/control`, { owner, ...action });
  assert.equal(
    (await control("native", { t: "assign", player: 0, seat: 1 })).status,
    409,
  );
  assert.equal(
    (await control("native", { t: "kick", player: 0 })).status,
    409,
  );
  assert.equal(
    (
      await control("native", {
        t: "disconnect-policy",
        disconnectPolicy: "continue",
      })
    ).status,
    409,
  );
  for (const player of [0, 1]) {
    const result = await control("host", {
      t: "assign",
      player,
      seat: 1 - player,
    });
    assert.equal(result.status, 200);
  }
  assert.deepEqual(stored.seats, [1, 0]);
  assert.equal(
    (await control("native", { t: "start-request" })).status,
    409,
  );
  web.send({ t: "start-request", generation: stored.generation });
  assert.equal((await client.queue.next()).command, CMD.REQUEST_STATE);
  for (let n = 0; n < 2; n++)
    assert.equal((await client.queue.next()).command, CMD.INPUT);
  const state = Buffer.alloc(128, 17);
  client.socket.write(packet(CMD.LOAD_STATE, statePayload(3, state, 7, false)));
  let prepare;
  do prepare = await web.queue.next();
  while (prepare.t !== "prepare");
  assert.equal(prepare.nativeState, true);
  assert.equal(prepare.host, 1);
  const transfer = await web.queue.next();
  assert.equal(transfer.t, "state");
  assert.deepEqual(await web.queue.next(), state);
  web.send({
    t: "ready",
    revision: transfer.revision,
    generation: stored.generation,
  });
  let input;
  do input = await client.queue.next();
  while (input.command === CMD.MODE);
  assert.equal(input.command, CMD.INPUT);
  const frame = input.payload.readUInt32BE(0);
  client.socket.write(
    Buffer.concat([
      packet(CMD.INPUT, words(frame, 1, 0)),
      packet(CMD.INPUT, words(frame + 1, 1, 0)),
    ]),
  );
  assert.equal((await client.queue.next()).command, CMD.LOAD_STATE);
  assert.equal((await client.queue.next()).command, CMD.STALL);
  let start;
  do start = await web.queue.next();
  while (start.t !== "start");
  assert.equal(stored.running, true);
  assert.equal(stored.host, 1);
  assert.equal(stored.metadata().roomHost, 0);
  assert.equal(stored.saveHost(), 0);
  await f.api(`/v1/rooms/${room.id}/leave`, { owner: "host" });
  assert.equal(stored.metadata().roomHost, 1);
  assert.equal(stored.metadata().owner, "native");
});

test("Windows handoff retains the account, member count and chosen seat", async (t) => {
  const f = await fixture(t);
  const { data: room } = await f.api("/v1/rooms", preparedManifest);
  await f.web(room.hostPath);
  const { data: joined } = await f.api(`/v1/rooms/${room.id}/join`, {
    owner: "guest",
    romId: 11,
  });
  const guest = await f.web(joined.peerPath);
  const stored = f.bridge.rooms.get(room.id);
  stored.seats = [0, 1];
  stored.state = Buffer.alloc(128);
  const response = await f.api(`/v1/rooms/${room.id}/native`, {
    owner: "guest",
    romId: 11,
    nickname: "Guest",
    clientPlatform: "windows-x86_64",
    battery: "AQID",
  });
  assert.equal(response.status, 201);
  assert.equal(response.data.player, joined.player);
  const prepared = stored.metadata();
  assert.equal(prepared.current, 2);
  assert.deepEqual(prepared.seats, [0, 1]);
  assert.equal(
    prepared.members.filter((member) => member.owner === "guest").length,
    1,
  );
  assert.equal(
    prepared.members.find((member) => member.owner === "guest").kind,
    "preparing",
  );
  let event;
  do {
    event = await guest.queue.next();
  } while (event.t !== "handoff");
  const duplicate = await f.api(`/v1/rooms/${room.id}/join`, {
    owner: "guest",
    romId: 11,
  });
  assert.equal(duplicate.status, 409);
  const desktop = await native({
    ...room,
    password: response.data.nativePassword,
  });
  t.after(() => desktop.socket.destroy());
  const member = stored
    .metadata()
    .members.find((item) => item.owner === "guest");
  assert.equal(member.kind, "native");
  assert.equal(member.clientPlatform, "windows-x86_64");
  assert.equal(stored.metadata().current, 2);
  assert.deepEqual(
    stored.peers.get(joined.player).initialBattery,
    Buffer.from([1, 2, 3]),
  );
  assert.equal(stored.reservations.size, 0);
  assert.equal(stored.admitNative({ salt: 1 }, Buffer.alloc(64, 48)), false);
});

test("retained room controls survive launcher cancellation, expiry and native exit", async (t) => {
  const f = await fixture(t);
  const { data: room } = await f.api("/v1/rooms", preparedManifest);
  await f.web(room.hostPath);
  const { data: joined } = await f.api(`/v1/rooms/${room.id}/join`, {
    owner: "guest",
    romId: 11,
  });
  const guest = await f.web(joined.peerPath + "&retainRoom=1&manualJoin=1");
  const stored = f.bridge.rooms.get(room.id);
  const original = stored.peers.get(1);
  stored.seats = [0, 1];
  stored.state = Buffer.alloc(128);
  async function message(type) {
    for (;;) {
      const value = await guest.queue.next();
      if (value.t === type) return value;
      assert.notEqual(value.t, "disconnect");
    }
  }
  const prepare = async () => {
    const result = await f.api(`/v1/rooms/${room.id}/native`, {
      owner: "guest",
      romId: 11,
      clientPlatform: "windows-x86_64",
      battery: "AQID",
    });
    assert.equal(result.status, 201);
    assert.equal((await message("handoff")).retainRoom, true);
    assert.equal(stored.controllers.get(1), original);
    assert.equal(guest.ws.readyState, WebSocket.OPEN);
    assert.equal(stored.metadata().current, 2);
    assert.equal(
      stored.members().filter((member) => member.owner === "guest").length,
      1,
    );
    return result.data;
  };
  for (const action of ["cancel", "expire", "disconnect"]) {
    const prepared = await prepare();
    if (action === "cancel") {
      assert.equal(
        (
          await f.api(
            `/v1/rooms/${room.id}/native/${prepared.credential}`,
            undefined,
            "DELETE",
          )
        ).status,
        200,
      );
    } else if (action === "expire") {
      stored.reservations.get(1).until = Date.now() - 1;
      stored.expireReservations();
    } else {
      const desktop = await native({
        ...room,
        password: prepared.nativePassword,
      });
      desktop.socket.destroy();
    }
    await message("returned");
    assert.equal(stored.peers.get(1), original);
    assert.equal(stored.controllers.size, 0);
    assert.equal(stored.metadata().current, 2);
    assert.deepEqual(stored.seats, [0, 1]);
    assert.equal(stored.members()[1].ready, false);
    assert.equal(stored.closed, false);
    assert.equal(guest.ws.readyState, WebSocket.OPEN);
  }
  const prepared = await prepare();
  const desktop = await native({ ...room, password: prepared.nativePassword });
  const closed = once(guest.ws, "close");
  await f.api(`/v1/rooms/${room.id}/leave`, { owner: "guest" });
  await closed;
  for (let n = 0; stored.peers.has(1) && n < 100; n++) await delay(5);
  assert.equal(stored.peers.has(1), false);
  assert.equal(stored.controllers.size, 0);
  assert.equal(stored.reservations.size, 0);
  assert.equal(stored.members().length, 1);
  assert.equal(stored.closed, false);
  desktop.socket.destroy();
});

test("closing the retained room page revokes an unfinished Windows launch", async (t) => {
  const f = await fixture(t);
  const { data: room } = await f.api("/v1/rooms", {
    ...preparedManifest,
    nativeAuthority: true,
    maxPrediction: 12,
  });
  const browser = await f.web(room.hostPath + "&retainRoom=1&manualJoin=1");
  const stored = f.bridge.rooms.get(room.id);
  const result = await f.api(`/v1/rooms/${room.id}/native`, {
    owner: "host",
    romId: 11,
    clientPlatform: "windows-x86_64",
  });
  assert.equal(result.status, 201);
  browser.ws.close();
  for (let n = 0; !stored.closed && n < 100; n++) await delay(5);
  assert.equal(stored.closed, true);
  assert.equal(stored.controllers.size, 0);
  assert.equal(stored.reservations.size, 0);
});

test("host handoff elects a browser host and maps wire client zero separately", async (t) => {
  const f = await fixture(t);
  const { data: room } = await f.api("/v1/rooms", preparedManifest);
  await f.web(room.hostPath);
  const rejected = await f.api(`/v1/rooms/${room.id}/native`, {
    owner: "host",
    romId: 11,
    clientPlatform: "windows-x86_64",
  });
  assert.equal(rejected.status, 409);
  const { data: joined } = await f.api(`/v1/rooms/${room.id}/join`, {
    owner: "guest",
    romId: 11,
  });
  await f.web(joined.peerPath);
  const stored = f.bridge.rooms.get(room.id);
  stored.seats = [0, 1];
  stored.state = Buffer.alloc(128);
  const { data: preparation } = await f.api(`/v1/rooms/${room.id}/native`, {
    owner: "host",
    romId: 11,
    clientPlatform: "windows-x86_64",
  });
  assert.equal(preparation.player, 0);
  assert.equal(stored.host, 1);
  const desktop = await native({
    ...room,
    password: preparation.nativePassword,
  });
  t.after(() => desktop.socket.destroy());
  const peer = stored.peers.get(0);
  assert.equal(peer.wirePlayer(0), 1);
  assert.equal(peer.wirePlayer(1), 0);
  assert.equal(stored.metadata().current, 2);
  assert.deepEqual(stored.seats, [0, 1]);
  peer.sendInput(0, 0, 7);
  assert.equal((await desktop.queue.next()).payload.readUInt32BE(4), 1);
});

test("native preparation can select a free seat and its launch credential still expires", async (t) => {
  const f = await fixture(t);
  const { data: room } = await f.api("/v1/rooms", {
    ...preparedManifest,
    system: "gba",
    coreName: "mGBA Splitscreen",
    cartridges: [
      preparedManifest.cartridges[0],
      { ...preparedManifest.cartridges[1], romId: 12 },
    ],
  });
  await f.web(room.hostPath);
  const { data: pending } = await f.api(`/v1/rooms/${room.id}/native`, {
    owner: "guest",
    romId: 12,
    clientPlatform: "windows-x86_64",
  });
  const endpoint = `/v1/rooms/${room.id}/native/${pending.credential}`;
  assert.equal((await f.api(endpoint, { seat: 0 }, "PATCH")).status, 200);
  assert.equal((await f.api(endpoint, { seat: 1 }, "PATCH")).status, 200);
  const stored = f.bridge.rooms.get(room.id);
  stored.reservations.get(pending.player).until = 0;
  stored.probePeers();
  assert.equal(stored.metadata().current, 1);
  assert.equal(stored.seats[pending.player], null);
  assert.equal((await f.api(endpoint)).status, 404);
});

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
  const peer = stored.peers.get(1);
  peer.probe = { sent: performance.now() - 16000 };
  stored.probePeers();
  assert.equal(
    peer.socket.destroyed,
    false,
    "Handshake uses its own deadline before PLAY",
  );
  peer.probe = null;
  stored.probePeers();
  assert.equal(
    peer.probe,
    null,
    "Do not send heartbeat probes before native readiness",
  );
  peer.ready = true;
  stored.probePeers();
  assert.equal((await desktop.queue.next()).command, CMD.PING);
});

test(
  "native lobby sends idle frames beyond RetroArch's ten-second stall limit",
  { timeout: 18000 },
  async (t) => {
    const f = await fixture(t);
    const { data: room } = await f.api("/v1/rooms", {
      ...manifest,
      manualStart: true,
      nativeAllowed: true,
      maxPrediction: 12,
    });
    const host = await f.web(room.hostPath);
    host.ws.on("message", (bytes, binary) => {
      if (binary) return;
      const message = JSON.parse(bytes);
      if (message.t === "ping") host.send({ t: "pong", nonce: message.nonce });
    });
    host.send({ t: "state", f: 0, size: 128, sram: "" });
    host.ws.send(Buffer.alloc(128, 17));
    let ready;
    do {
      ready = await host.queue.next();
    } while (ready.t !== "state-ready");
    host.send({ t: "ready", revision: ready.revision });
    const desktop = await native(room);
    t.after(() => desktop.socket.destroy());
    desktop.socket.write(packet(CMD.PLAY, words(0)));
    const began = performance.now();
    let frame = 0;
    while (frame < 7) {
      const message = await desktop.queue.next();
      if (message.command === CMD.PING) {
        desktop.socket.write(packet(CMD.PONG));
        continue;
      }
      assert.equal(message.command, CMD.INPUT);
      assert.deepEqual(message.payload, words(frame++, 0, 0));
    }
    assert(performance.now() - began > 10000);
    const stored = f.bridge.rooms.get(room.id);
    assert.notEqual(stored.running, true);
    assert.equal(stored.started, false);
    assert.deepEqual(stored.seats, [null, null]);
    assert.equal(stored.peers.get(1).nextFrame, 0);
    assert.equal(desktop.socket.destroyed, false);
  },
);

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

test("web host progress paces an ahead native peer over the existing TCP connection", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const entries = [];
  const f = await fixture(t, { logger: (entry) => entries.push(entry) });
  const { data: room } = await f.api("/v1/rooms", {
    ...manifest,
    maxPrediction: 12,
    nativeAllowed: true,
  });
  const host = await f.web(room.hostPath);
  await initial(host);
  const client = await native(room);
  t.after(() => client.socket.destroy());
  client.socket.setNoDelay(true);
  client.socket.write(packet(CMD.PLAY, words(0)));
  assert.equal((await client.queue.next()).command, CMD.MODE);
  assert.equal((await client.queue.next()).command, CMD.INPUT);
  client.socket.write(
    Buffer.concat([
      packet(CMD.INPUT, words(0, 1, 0)),
      packet(CMD.INPUT, words(1, 1, 0)),
    ]),
  );
  assert.equal((await client.queue.next()).command, CMD.LOAD_STATE);
  assert.equal((await client.queue.next()).command, CMD.STALL);
  assert.equal((await host.queue.next()).t, "start");
  host.send({ t: "input", f: 0, b: 0 });
  host.send({ t: "progress", f: 1, confirmed: 1 });
  assert.equal((await client.queue.next()).command, CMD.INPUT);
  const pong = once(host.ws, "pong");
  host.ws.ping();
  await pong;
  // Advance both protocol peers without running an emulator. PONG barriers
  // make the cross-socket input/confirmation order deterministic.
  for (let frame = 1; frame <= 120; frame++) {
    client.socket.write(
      Buffer.concat([
        packet(CMD.INPUT, words(frame + 1, 1, frame)),
        packet(CMD.PING),
      ]),
    );
    assert.equal((await client.queue.next()).command, CMD.PONG);
    host.send({ t: "input", f: frame, b: 256 });
    host.send({ t: "progress", f: frame + 1, confirmed: frame + 1 });
    assert.deepEqual(
      (await client.queue.next()).payload,
      words(frame + 1, 0, 256),
    );
  }
  now = 2000;
  client.socket.write(
    Buffer.concat([
      ...Array.from({ length: 8 }, (_, i) =>
        packet(CMD.INPUT, words(122 + i, 1, 32)),
      ),
      packet(CMD.PING),
    ]),
  );
  assert.equal((await client.queue.next()).command, CMD.PONG);
  host.send({ t: "progress", f: 121, confirmed: 121 });
  const correction = await client.queue.next();
  assert.equal(correction.command, CMD.STALL);
  assert.deepEqual(correction.payload, words(6));
  const paced = entries.filter((entry) => entry.event === "native-paced");
  assert.equal(paced.length, 1);
  assert.equal(paced[0].leadFrames, 8);
  assert.equal(paced[0].stallFrames, 6);
  assert(f.bridge.rooms.get(room.id).running);
  host.send({ t: "input", f: 121, b: 128 });
  assert.deepEqual((await client.queue.next()).payload, words(122, 0, 128));
  client.socket.write(packet(CMD.INPUT, words(130, 1, 64)));
  let last;
  do last = await host.queue.next();
  while (last.t === "input" && last.f < 129);
  assert.deepEqual(last, { t: "input", f: 129, b: 64, player: 1 });
});

test("a waiting native rejoin isolates pause and checkpoints until the new game starts", async (t) => {
  const entries = [];
  const f = await fixture(t, { logger: (entry) => entries.push(entry) });
  const { data: room } = await f.api("/v1/rooms", {
    ...preparedManifest,
    maxPrediction: 12,
  });
  const host = await f.web(room.hostPath);
  const stored = f.bridge.rooms.get(room.id);
  const pauses = [];
  host.ws.on("message", (bytes, binary) => {
    if (binary) return;
    const message = JSON.parse(bytes.toString());
    if (message.t === "pause") pauses.push(message.paused);
  });
  const send = (message) =>
    host.send({ ...message, generation: stored.generation });
  async function webBarrier() {
    const pong = once(host.ws, "pong");
    host.ws.ping();
    await pong;
  }
  async function ignoreNativePause(desktop) {
    const count = pauses.length;
    const paused = stored.paused;
    desktop.socket.write(
      Buffer.concat([
        packet(CMD.PAUSE, fixedString("Desktop")),
        packet(CMD.RESUME),
        packet(CMD.PING),
      ]),
    );
    assert.equal((await desktop.queue.next()).command, CMD.PONG);
    await webBarrier();
    assert.equal(pauses.length, count);
    assert.equal(stored.paused, paused);
  }
  async function webMessage(type) {
    for (;;) {
      const message = await host.queue.next();
      assert.notEqual(message.t, "disconnect", message.message);
      if (message.t === type) return message;
    }
  }
  async function uploadState() {
    send({
      t: "state",
      f: 0,
      size: 128,
      sram: "",
      ...(stored.pendingBatteries.has(1) ? { batteryPlayer: 1 } : {}),
    });
    host.ws.send(Buffer.alloc(128, 17));
    const ready = await webMessage("state-ready");
    send({ t: "ready", revision: ready.revision });
  }
  async function connectNative() {
    const { status, data: prepared } = await f.api(
      `/v1/rooms/${room.id}/native`,
      {
        owner: "guest",
        romId: 11,
        clientPlatform: "windows-x86_64",
      },
    );
    assert.equal(status, 201);
    const desktop = await native({
      ...room,
      password: prepared.nativePassword,
    });
    t.after(() => desktop.socket.destroy());
    desktop.socket.setNoDelay(true);
    desktop.socket.write(packet(CMD.PLAY, words(0)));
    assert.equal((await desktop.queue.next()).command, CMD.INPUT);
    return desktop;
  }
  async function startGame(desktop) {
    send({ t: "assign", player: 0, seat: 0 });
    send({ t: "assign", player: 1, seat: 1 });
    send({ t: "start-request" });
    await webMessage("prepare");
    if (stored.hadGame) {
      const count = pauses.length;
      send({ t: "pause", paused: true });
      send({ t: "pause", paused: false });
      await webBarrier();
      assert.equal(stored.closed, false);
      assert.equal(pauses.length, count);
      await ignoreNativePause(desktop);
    }
    await uploadState();
    let bootstrap;
    do bootstrap = await desktop.queue.next();
    while (bootstrap.command === CMD.MODE);
    assert.equal(bootstrap.command, CMD.INPUT);
    const frame = bootstrap.payload.readUInt32BE(0);
    await ignoreNativePause(desktop);
    desktop.socket.write(
      Buffer.concat([
        packet(CMD.INPUT, words(frame, 1, 0)),
        packet(CMD.INPUT, words(frame + 1, 1, 0)),
      ]),
    );
    const load = await desktop.queue.next();
    assert.equal(load.command, CMD.LOAD_STATE);
    assert.deepEqual(
      readStatePayload(load.payload, 7, false, 128).state,
      stored.state,
    );
    assert.equal((await desktop.queue.next()).command, CMD.STALL);
    await webMessage("start");
    assert(stored.peers.get(1).playing);
  }
  await uploadState();
  const first = await connectNative();
  await startGame(first);
  assert.equal(
    (await f.api(`/v1/rooms/${room.id}/leave`, { owner: "guest" })).status,
    200,
  );
  assert.equal(stored.peers.size, 1);
  assert(stored.running);
  const desktop = await connectNative();
  const waiting = stored.peers.get(1);
  assert.equal(waiting.playing, false);
  const generation = stored.generation;
  // Twenty checkpoints exceed the 16-entry native verification window. The
  // browser keeps playing while the reconnected native client waits in the lobby.
  for (let frame = 0; frame < 1200; frame++) {
    send({ t: "input", f: frame, b: 0 });
    send({ t: "progress", f: frame + 1, confirmed: frame + 1 });
    if ((frame + 1) % 60 === 0) send({ t: "crc", f: frame + 1, crc: 123 });
  }
  for (
    let i = 0;
    i < 300 && !stored.closed && stored.latestCheckpoint < 1200;
    i++
  )
    await delay(5);
  assert.equal(
    stored.closed,
    false,
    entries.find((entry) => entry.event === "room-closed")?.reason,
  );
  assert.equal(stored.latestCheckpoint, 1200);
  assert.equal(stored.generation, generation);
  assert.equal(waiting.pendingChecks.size, 0);
  assert.equal(waiting.checksSent, 0);
  assert.equal(waiting.lastReportedFrame, 0);
  waiting.keepLobbyAlive();
  assert.equal((await desktop.queue.next()).command, CMD.INPUT);
  assert.equal(desktop.queue.values.length, 0);
  await ignoreNativePause(desktop);
  send({ t: "pause", paused: true });
  assert.equal((await webMessage("pause")).paused, true);
  await ignoreNativePause(desktop);
  send({ t: "pause", paused: false });
  assert.equal((await webMessage("pause")).paused, false);
  assert.equal(desktop.queue.values.length, 0);
  await startGame(desktop);
  desktop.socket.write(packet(CMD.PAUSE, fixedString("Desktop")));
  assert.equal((await webMessage("pause")).paused, true);
  desktop.socket.write(packet(CMD.RESUME));
  assert.equal((await webMessage("pause")).paused, false);
  const offset = waiting.frameOffset;
  send({ t: "input", f: 0, b: 128 });
  send({ t: "progress", f: 1, confirmed: 1 });
  send({ t: "crc", f: 1, crc: 456 });
  assert.deepEqual((await desktop.queue.next()).payload, words(offset, 0, 128));
  desktop.socket.write(packet(CMD.INPUT, words(offset + 1, 1, 32)));
  const check = await desktop.queue.next();
  assert.equal(check.command, CMD.CRC);
  assert.deepEqual(check.payload, words(offset + 1, 456));
  assert.equal(waiting.checksSent, 1);
  assert.equal(waiting.pendingChecks.size, 0);
  assert(stored.running);
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
  for (const protocol of [5, 7])
    for (const compressed of [false, true])
      assert.deepEqual(
        readStatePayload(
          statePayload(2, state, protocol, compressed),
          protocol,
          compressed,
        ),
        { frame: 2, state },
      );
  const oversized = words(0, MAX_STATE + 65537);
  assert.throws(() => readStatePayload(oversized, 7, true), /size/);
  assert.throws(
    () =>
      readStatePayload(statePayload(0, Buffer.alloc(0), 7, false), 7, false),
    /block/,
  );
  assert.throws(
    () =>
      readStatePayload(
        statePayload(2, state, 7, false).subarray(0, -1),
        7,
        false,
      ),
    /Truncated/,
  );
});
