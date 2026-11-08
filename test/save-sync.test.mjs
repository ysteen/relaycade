import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { extractSaves } from "../save-extract.mjs";
import { SaveOutbox } from "../save-outbox.mjs";
import { createBridge } from "../server.mjs";
import { BridgeConnection } from "../client/bridge-session.js";

const profiles = {
  gba: {
    system: "gba",
    coreName: "mGBA Splitscreen",
    coreVersion: "0.1.0-f1d5975-rollback2",
    players: 2,
  },
  gb: {
    system: "gb",
    coreName: "SameBoy",
    coreVersion: "1.0.4c87d256-rollback2",
    players: 2,
  },
  snes: {
    system: "snes",
    coreName: "Snes9x",
    coreVersion: "1.632d4cce69",
    players: 2,
    saveSize: 4,
  },
};

function snes(seed) {
  const sram = Buffer.alloc(0x80000, seed);
  return Buffer.concat([Buffer.from("#!s9xsnp:0012\nSRA:524288:"), sram]);
}

function gba(seeds) {
  const parts = seeds.map((seed) => {
    const bytes = Buffer.alloc(0x61000 + 32 + 512);
    bytes.writeUInt32LE(2, 0x61000);
    bytes.writeUInt32LE(512, 0x61004);
    bytes.writeBigUInt64LE(BigInt(0x61000 + 32), 0x61008);
    bytes.fill(seed, 0x61000 + 32);
    return bytes;
  });
  const header = Buffer.alloc(12 + seeds.length * 4);
  header.write("SPST");
  header.writeUInt32LE(4, 4);
  header.writeUInt32LE(seeds.length, 8);
  parts.forEach((part, i) => header.writeUInt32LE(part.length, 12 + i * 4));
  return Buffer.concat([header, ...parts]);
}

function gb(seeds) {
  const parts = seeds.map((seed) => {
    const bytes = Buffer.alloc(32 + 512 + 216 + 8 + 8);
    bytes.fill(seed, 32, 544);
    bytes.write("CORE", 544);
    bytes.writeUInt32LE(208, 548);
    bytes.writeUInt16LE(1, 552);
    bytes.writeUInt32LE(512, 552 + 168);
    bytes.writeUInt32LE(32, 552 + 172);
    bytes.write("END ", 760);
    bytes.writeUInt32LE(544, 768);
    bytes.write("BESS", 772);
    return bytes;
  });
  const trailer = Buffer.alloc(48);
  trailer.write("SBR2");
  trailer.writeUInt32LE(seeds.length, 4);
  return Buffer.concat([...parts, Buffer.alloc(32), trailer]);
}

test("pinned core snapshots extract each cartridge's SRAM and trim the shared SNES save", () => {
  for (const [system, state] of [
    ["gba", gba([11, 22])],
    ["gb", gb([11, 22])],
    ["snes", snes(11)],
  ]) {
    const values = extractSaves(profiles[system], state);
    assert.equal(values.length, system === "snes" ? 1 : 2);
    values.forEach((value, index) => {
      assert.equal(value.length, system === "snes" ? 4 : 512);
      assert(value.every((byte) => byte === (index ? 22 : 11)));
    });
    assert.throws(() =>
      extractSaves({ ...profiles[system], coreVersion: "unknown" }, state),
    );
    assert.throws(() => extractSaves(profiles[system], state.subarray(0, 18)));
  }
  const invalid = gba([1, 2]);
  invalid.writeBigUInt64LE(0xffffffffffffffffn, 20 + 0x61008);
  assert.throws(() => extractSaves(profiles.gba, invalid));
  assert.deepEqual(
    extractSaves({ ...profiles.gba, players: 4 }, gba([1, 2, 3, 4])).map(
      (save) => save[0],
    ),
    [1, 2, 3, 4],
  );
});

test("cable state profiles preserve cartridge save extraction and reject old state headers", () => {
  const gbaState = gba([31, 47]);
  gbaState.writeUInt32LE(5, 4);
  const gbState = Buffer.concat([gb([31, 47]), Buffer.alloc(16)]);
  gbState.write("SBR3", gbState.length - 64);
  for (const [system, state, old] of [
    ["gba", gbaState, gba([31, 47])],
    ["gb", gbState, gb([31, 47])],
  ]) {
    const profile = {
      ...profiles[system],
      coreVersion: profiles[system].coreVersion.replace("rollback2", "cable1"),
    };
    assert.deepEqual(
      extractSaves(profile, state).map((bytes) => bytes[0]),
      [31, 47],
    );
    assert.throws(() => extractSaves(profile, old));
    assert.throws(() => extractSaves(profiles[system], state));
  }
});

test("durable save receipts survive restart, preserve retry errors and cannot acknowledge a newer revision", async (t) => {
  const path = await mkdtemp(join(tmpdir(), "bridge-saves-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  let box = await new SaveOutbox(path).init();
  const value = {
    roomId: "closed-room",
    player: 1,
    owner: "original",
    romId: 2,
    coreName: "SameBoy",
    generation: 2,
    frame: 60,
    battery: "AQID",
  };
  await box.put(value);
  const old = box.list()[0];
  await box.acknowledge(old.id, old.revision, "RomM is unavailable");
  box = await new SaveOutbox(path).init();
  assert.equal(box.list()[0].error, "RomM is unavailable");
  await box.put({ ...value, frame: 120, battery: "BAUG" });
  assert.equal(await box.acknowledge(old.id, old.revision), false);
  await box.put({ ...value, frame: 90 });
  const latest = box.list()[0];
  assert.equal(latest.frame, 120);
  assert.equal(latest.battery, "BAUG");
  const write = box.write;
  box.write = async () => {
    throw new Error("Disk full");
  };
  await assert.rejects(box.put({ ...value, frame: 121 }), /Disk full/);
  assert.equal(box.list()[0].revision, latest.revision);
  box.write = write;
  await box.put({ ...value, owner: "replacement", frame: 1, battery: "BwgJ" });
  assert.equal(box.list().length, 2);
  await box.acknowledge(latest.id, latest.revision);
  assert.equal(box.list()[0].owner, "replacement");
});

class Core {
  profile = { core: "snes9x", sharedSave: true, memoryIds: [0] };
  data = snes(0);
  size = this.data.length;
  save() {
    return this.data.slice();
  }
  load(bytes) {
    this.data.set(bytes);
  }
  memory() {
    return this.data.subarray(25, 29);
  }
  loadMemory(_id, bytes) {
    this.memory().set(bytes);
  }
  stepPlayers() {
    this.data[25]++;
  }
}

async function until(predicate) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail("Save synchronization timed out");
}

test("web and native checkpoints use the frozen accounts, survive room deletion and are consumed over the service API", async (t) => {
  const path = await mkdtemp(join(tmpdir(), "bridge-room-saves-"));
  const adminToken = "test-server-save-admin-token";
  let bridge = await createBridge({
    adminToken,
    saveDirectory: path,
    logger() {},
  });
  t.after(async () => {
    await bridge.close();
    await rm(path, { recursive: true, force: true });
  });
  let base = `http://127.0.0.1:${bridge.address.port}`;
  async function api(path, body, method = body ? "POST" : "GET") {
    const response = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(response.ok, true, await response.clone().text());
    return response.json();
  }
  const cartridge = { romId: 1, sha256: "a".repeat(64), size: 32768, crc32: 1 };
  const created = await api("/v1/rooms", {
    ...profiles.snes,
    romId: 1,
    owner: "11",
    saveAllowed: true,
    cartridges: [cartridge],
    manualStart: true,
    stateSize: new Core().size,
    contentCrc: 1,
    password: "",
  });
  const joined = await api(`/v1/rooms/${created.id}/join`, {
    owner: "22",
    romId: 1,
    saveAllowed: true,
  });
  const connect = (path, player) =>
    new BridgeConnection(
      new Core(),
      new WebSocket(base.replace("http:", "ws:") + path),
      { player, players: 2, battery: Buffer.alloc(4, 11) },
    );
  const host = connect(created.hostPath, 0),
    guest = connect(joined.peerPath, 1);
  t.after(() => {
    host.stop();
    guest.stop();
  });
  await until(() => host.manualStart && guest.manualStart);
  const room = bridge.rooms.get(created.id);
  host.assignPlayer(0, 0);
  guest.assignPlayer(1, 1);
  await until(() => room.canStart());
  host.startGame();
  await until(() => host.started && guest.started);
  assert.equal(host.serverSaves, true);
  for (let i = 0; i < 3; i++) {
    host.tick(0);
    guest.tick(0);
    await delay(10);
  }
  await host.saveProgress();
  let entries = await api("/v1/rooms/save-queue");
  assert.deepEqual(entries.map((entry) => entry.owner).sort(), ["11", "22"]);
  let frame = entries[0].frame;
  assert(
    entries.every((entry) =>
      Buffer.from(entry.battery, "base64").equals(
        Buffer.from(host.session.confirmedMemory(0)),
      ),
    ),
  );
  const source = room.peers.get(0);
  source.owner = "replacement";
  await assert.rejects(
    room.captureSaves(source, frame, host.adapter.save()),
    /No active game/,
  );
  source.owner = "11";
  for (let i = 0; i < 3; i++) {
    host.tick(0);
    guest.tick(0);
    await delay(10);
  }
  room.requestSave();
  await until(() =>
    room.bridge.saves.list().every((entry) => entry.frame > frame),
  );
  await room.bridge.saves.pending;
  frame = room.bridge.saves.list()[0].frame;
  entries = await api("/v1/rooms/save-queue");
  const snapshot = host.adapter.save();
  snapshot[25] = 66;
  room.gameOwners[1].saveAllowed = false;
  await room.captureSaves(source, frame, snapshot);
  assert.equal(
    room.bridge.saves.list().find((entry) => entry.owner === "22").battery,
    entries.find((entry) => entry.owner === "22").battery,
  );
  room.gameOwners[1].saveAllowed = true;
  snapshot[25] = 77;
  room.nativeCheckpoint(source, frame, snapshot, room.generation - 1);
  assert.equal(
    Buffer.from((await api("/v1/rooms/save-queue"))[0].battery, "base64")[0],
    66,
  );
  source.kind = "native";
  room.nativeCheckpoint(source, frame, snapshot, room.generation);
  source.kind = "web";
  await until(() => room.saveDigests.size > 0);
  await delay(30);
  guest.stop();
  await until(() => !room.peers.has(1));
  host.stop();
  await until(() => !bridge.rooms.size);
  await bridge.close();
  bridge = await createBridge({ adminToken, saveDirectory: path, logger() {} });
  base = `http://127.0.0.1:${bridge.address.port}`;
  assert.equal((await fetch(base + "/v1/rooms/save-queue")).status, 401);
  entries = await api("/v1/rooms/save-queue");
  assert.equal(entries.length, 2);
  assert(
    entries.every((entry) => Buffer.from(entry.battery, "base64")[0] === 77),
  );
  for (const entry of entries)
    await api(`/v1/rooms/save-queue/${entry.id}`, { revision: entry.revision });
  assert.deepEqual(await api("/v1/rooms/save-queue"), []);
});
