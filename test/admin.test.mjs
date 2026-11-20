import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeAdmin } from "../admin.mjs";
import { createBridge } from "../server.mjs";

test("the bridge ships its administration UI behind service authentication", async (t) => {
  const adminToken = "test-admin-ui-token-at-least-24-characters";
  const service = await createBridge({ adminToken, logger() {} });
  t.after(() => service.close());
  const base = `http://127.0.0.1:${service.address.port}/v1/rooms/admin/ui/`;
  for (const [name, mime] of [
    ["index.html", "text/html"],
    ["admin.js", "text/javascript"],
    ["admin.css", "text/css"],
  ]) {
    assert.equal((await fetch(base + name)).status, 401);
    const response = await fetch(base + name, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(response.status, 200);
    assert(response.headers.get("content-type").startsWith(mime));
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      await readFile(new URL(`../admin-ui/${name}`, import.meta.url)),
    );
  }
  for (const name of [
    "settings.json",
    "nested/admin.js",
    "%2e%2e%2fserver.mjs",
    "constructor",
  ]) {
    const response = await fetch(base + name, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(response.status, 404, name);
  }
});

test("management logs are bounded, exclude credentials and retain diagnostic fields", () => {
  const admin = new BridgeAdmin(null, 8);
  for (let i = 0; i < 510; i++)
    admin.record({
      time: new Date().toISOString(),
      event: "native-connect",
      player: i,
      password: "secret",
      credential: "secret",
      token: "secret",
      state: "payload",
      coreName: "SameBoy",
      large: "x".repeat(1024),
    });
  const result = admin.logs();
  assert.equal(result.events.length, 500);
  assert.equal(result.cursor, 510);
  assert.equal(admin.logs(509).events.length, 1);
  assert.equal(result.events[0].fields.large.length, 512);
  assert.equal(result.events[0].fields.coreName, "SameBoy");
  assert(!JSON.stringify(result).includes("secret"));
  assert(!JSON.stringify(result).includes("payload"));
});

test("admin settings require the service token, survive restart and leave existing rooms connected", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-admin-"));
  const adminToken = "test-admin-token-24-characters";
  let service = await createBridge({
    adminToken,
    saveDirectory: directory,
    logger() {},
  });
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  const call = (path, method = "GET", value, authorized = true) =>
    fetch(`http://127.0.0.1:${service.address.port}/v1/rooms${path}`, {
      method,
      headers: {
        ...(authorized ? { Authorization: `Bearer ${adminToken}` } : {}),
        "Content-Type": "application/json",
      },
      body: value ? JSON.stringify(value) : undefined,
    });
  assert.equal((await call("/admin", "GET", undefined, false)).status, 401);
  assert.equal(
    (await call("/admin/logs", "GET", undefined, false)).status,
    401,
  );
  const payload = {
    system: "gb",
    coreName: "SameBoy",
    coreVersion: "1.0",
    players: 2,
    stateSize: 4,
    contentCrc: 1,
    owner: "admin-test",
  };
  assert.equal((await call("", "POST", payload)).status, 201);
  const settings = {
    roomsEnabled: false,
    maxRooms: 1,
    saveIntervalSeconds: 30,
  };
  assert.equal(
    (await call("/admin/settings", "PUT", settings, false)).status,
    401,
  );
  assert.equal(
    (
      await call("/admin/settings", "PUT", {
        ...settings,
        saveIntervalSeconds: 0,
      })
    ).status,
    400,
  );
  assert.equal((await call("/admin/settings", "PUT", settings)).status, 200);
  assert.equal((await call("", "POST", payload)).status, 409);
  const snapshot = await (await call("/admin")).json();
  assert.equal(snapshot.rooms.length, 1);
  assert.deepEqual(snapshot.settings, settings);
  assert.equal(snapshot.persistent, true);
  assert.equal(Object.hasOwn(snapshot.resources, "host"), false);
  assert(snapshot.resources.service.usedBytes > 0);
  assert(["container", "process"].includes(snapshot.resources.service.scope));
  const events = await (await call("/admin/logs")).json();
  assert(
    events.events.some((event) => event.event === "admin-settings-updated"),
  );
  assert.equal((await call("/admin/logs?after=-1")).status, 400);
  await service.close();
  service = await createBridge({
    adminToken,
    saveDirectory: directory,
    logger() {},
  });
  assert.deepEqual((await (await call("/admin")).json()).settings, settings);
});
