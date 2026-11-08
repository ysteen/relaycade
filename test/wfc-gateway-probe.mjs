import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { allowedWfcFrame } from "../wfc.mjs";

const child = spawn(process.argv[2], [], { stdio: ["pipe", "pipe", "pipe"] });
const timeout = setTimeout(() => {
  child.kill("SIGKILL");
  throw new Error("WFC gateway probe timed out");
}, 15000);
const mac = Buffer.from([2, 9, 191, 1, 2, 3]);
let pending = [],
  buffer = Buffer.alloc(0);
child.stderr.pipe(process.stderr);
child.stdout.on("data", (data) => {
  buffer = Buffer.concat([buffer, data]);
  while (buffer.length >= 2 && buffer.length >= buffer.readUInt16BE(0) + 2) {
    const n = buffer.readUInt16BE(0),
      frame = buffer.subarray(2, n + 2);
    buffer = buffer.subarray(n + 2);
    for (const waiter of [...pending])
      if (waiter.match(frame)) {
        pending = pending.filter((value) => value !== waiter);
        waiter.resolve(frame);
      }
  }
});
function wait(match) {
  return new Promise((resolve) => pending.push({ match, resolve }));
}
function send(frame) {
  assert.equal(allowedWfcFrame(frame), true);
  const header = Buffer.alloc(2);
  header.writeUInt16BE(frame.length);
  child.stdin.write(Buffer.concat([header, frame]));
}
function ethernet(type, payload, destination = Buffer.alloc(6, 255)) {
  const frame = Buffer.alloc(14 + payload.length);
  frame.set(destination);
  frame.set(mac, 6);
  frame.writeUInt16BE(type, 12);
  frame.set(payload, 14);
  return frame;
}
function udp(payload, from, to, sport, dport, destination) {
  const ip = Buffer.alloc(28 + payload.length);
  ip[0] = 0x45;
  ip.writeUInt16BE(ip.length, 2);
  ip[8] = 64;
  ip[9] = 17;
  ip.set(from, 12);
  ip.set(to, 16);
  let sum = 0;
  for (let i = 0; i < 20; i += 2) sum += ip.readUInt16BE(i);
  while (sum >> 16) sum = (sum & 65535) + (sum >> 16);
  ip.writeUInt16BE(~sum & 65535, 10);
  ip.writeUInt16BE(sport, 20);
  ip.writeUInt16BE(dport, 22);
  ip.writeUInt16BE(payload.length + 8, 24);
  ip.set(payload, 28);
  return ethernet(0x0800, ip, destination);
}
try {
  const discover = Buffer.alloc(244);
  discover[0] = 1;
  discover[1] = 1;
  discover[2] = 6;
  discover.writeUInt32BE(0x12345678, 4);
  discover.set(mac, 28);
  discover.writeUInt32BE(0x63825363, 236);
  discover.set([53, 1, 1, 255], 240);
  const offer = wait(
    (frame) =>
      frame.length > 282 && frame[23] === 17 && frame.readUInt16BE(36) === 68,
  );
  send(udp(discover, [0, 0, 0, 0], [255, 255, 255, 255], 68, 67));
  const offered = await offer;
  assert.deepEqual([...offered.subarray(58, 62)], [10, 0, 2, 15]);
  const arp = Buffer.alloc(28);
  arp.writeUInt16BE(1, 0);
  arp.writeUInt16BE(0x0800, 2);
  arp[4] = 6;
  arp[5] = 4;
  arp.writeUInt16BE(1, 6);
  arp.set(mac, 8);
  arp.set([10, 0, 2, 15], 14);
  arp.set([10, 0, 2, 2], 24);
  const reply = wait(
    (frame) =>
      frame.readUInt16BE(12) === 0x0806 && frame.readUInt16BE(20) === 2,
  );
  send(ethernet(0x0806, arp));
  const gatewayMac = (await reply).subarray(6, 12);
  const query = Buffer.concat([
    Buffer.from([0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
    ..."nas.nintendowifi.net"
      .split(".")
      .map((label) =>
        Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]),
      ),
    Buffer.from([0, 0, 1, 0, 1]),
  ]);
  const answer = wait(
    (frame) =>
      frame[23] === 17 &&
      frame.readUInt16BE(36) === 12345 &&
      frame.length >= 54,
  );
  send(udp(query, [10, 0, 2, 15], [178, 62, 43, 212], 12345, 53, gatewayMac));
  const dns = (await answer).subarray(42);
  assert.equal(dns.readUInt16BE(0), 0x1234);
  assert.equal(dns[3] & 15, 0);
  assert.ok(dns.readUInt16BE(6) > 0);
  console.log(
    JSON.stringify({
      dhcp: "pass",
      arp: "pass",
      wfcDns: "pass",
      answers: dns.readUInt16BE(6),
    }),
  );
} finally {
  clearTimeout(timeout);
  child.kill("SIGKILL");
}
