import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { WebSocket } from "ws";
import { allowedWfcFrame, publicIpv4, WfcGateway } from "../wfc.mjs";

function udp(destination = [178, 62, 43, 212]) {
  const frame = Buffer.alloc(46);
  frame.writeUInt16BE(0x0800, 12);
  frame[14] = 0x45;
  frame.writeUInt16BE(32, 16);
  frame[23] = 17;
  frame.set([10, 0, 2, 15], 26);
  frame.set(destination, 30);
  frame.writeUInt16BE(12345, 34);
  frame.writeUInt16BE(53, 36);
  frame.writeUInt16BE(12, 38);
  return frame;
}

test("WFC allows internet traffic and DHCP, blocks host access and fragments", () => {
  assert.equal(allowedWfcFrame(udp()), true);
  for (const ip of [
    [10, 0, 2, 2],
    [10, 0, 2, 3],
    [127, 0, 0, 1],
    [192, 168, 3, 1],
    [172, 16, 0, 1],
    [169, 254, 169, 254],
    [100, 64, 0, 1],
    [224, 0, 0, 1],
    [0, 0, 0, 0],
    [198, 18, 0, 1],
    [255, 255, 255, 255],
  ]) {
    assert.equal(publicIpv4(ip), false);
    assert.equal(allowedWfcFrame(udp(ip)), false);
  }
  const fragment = udp();
  fragment.writeUInt16BE(0x2000, 20);
  assert.equal(allowedWfcFrame(fragment), false);
  fragment.writeUInt16BE(1, 20);
  assert.equal(allowedWfcFrame(fragment), false);
  const dhcp = udp([255, 255, 255, 255]);
  dhcp.fill(0, 26, 30);
  dhcp.writeUInt16BE(68, 34);
  dhcp.writeUInt16BE(67, 36);
  assert.equal(allowedWfcFrame(dhcp), true);
  const shortTcp = udp();
  shortTcp[23] = 6;
  assert.equal(allowedWfcFrame(shortTcp), false);
  for (let length = 0; length < 42; length++)
    assert.equal(allowedWfcFrame(Buffer.alloc(length)), false);
});

test("WFC consumes tickets, enforces origin/account limits, transports frames and cleans up", async (t) => {
  const events = [];
  const gateway = new WfcGateway({
    helper: process.execPath,
    allowedOrigins: ["https://romm.example"],
    log: (...args) => events.push(args),
    spawnHelper: () =>
      spawn(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
        stdio: ["pipe", "pipe", "pipe"],
      }),
  });
  const server = createServer();
  server.on("upgrade", (...args) => gateway.upgrade(...args));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    gateway.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const ticket = await gateway.create("1");
  assert.equal(ticket.status, 201);
  assert.equal((await gateway.create("1")).status, 409);
  const url = `ws://127.0.0.1:${server.address().port}${ticket.path}`;
  const invalid = new WebSocket(url, { origin: "https://untrusted.example" });
  invalid.on("error", () => {});
  await new Promise((resolve) => invalid.once("close", resolve));
  const client = new WebSocket(url, { origin: "https://romm.example" });
  client.on("error", () => {});
  await once(client, "open");
  const replay = new WebSocket(url, { origin: "https://romm.example" });
  replay.on("error", () => {});
  await new Promise((resolve) => replay.once("close", resolve));
  const received = once(client, "message");
  client.send(udp());
  assert.deepEqual((await received)[0], udp());
  client.send(udp([127, 0, 0, 1]));
  await delay(20);
  client.close();
  await once(client, "close");
  await delay(20);
  assert.equal(gateway.sessions.size, 0);
  assert.equal(events.at(-1)[1].sent, 1);
  assert.equal(events.at(-1)[1].dropped, 1);
});

test("WFC disabled by default and expired tickets release capacity", async () => {
  let now = 0;
  const gateway = new WfcGateway({
    helper: process.execPath,
    allowedOrigins: ["https://romm.example"],
    log: () => {},
    now: () => now,
  });
  try {
    assert.equal((await gateway.create("1")).status, 201);
    now = 60_001;
    assert.equal((await gateway.create("1")).status, 201);
    gateway.helper = null;
    assert.equal((await gateway.create("2")).status, 503);
    gateway.helper = "/missing-wfc-helper";
    assert.equal((await gateway.create("2")).status, 503);
  } finally {
    gateway.close();
  }
});
