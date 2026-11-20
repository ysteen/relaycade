import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBridge } from "../server.mjs";

const origin = "https://admin.example.test";
const password = "test standalone password only";
const token = "test-romm-adapter-token-for-suite";
const replacement = "replacement-adapter-token-for-suite";

test("local administrator and the RomM adapter use separate credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-management-"));
  const options = {
    saveDirectory: directory,
    localAdmin: { password, publicOrigin: origin },
    logger() {},
  };
  let bridge;
  t.after(async () => {
    await bridge?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const call = async (path, method = "GET", headers = {}, body) =>
    fetch(`http://127.0.0.1:${bridge.address.port}${path}`, {
      method,
      headers,
      body: body && JSON.stringify(body),
    });

  bridge = await createBridge(options);
  assert.equal((await call("/admin/api/ui/")).status, 200);
  assert.equal((await call("/admin/api/context")).status, 401);
  assert.equal(
    (await call("/v1/rooms", "GET", { authorization: `Bearer ${token}` }))
      .status,
    401,
  );
  const credentials = { username: "admin", password };
  assert.equal(
    (
      await call(
        "/admin/api/login",
        "POST",
        { origin: "https://other.example.test" },
        credentials,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/admin/api/login",
        "POST",
        { origin },
        { ...credentials, password: token },
      )
    ).status,
    401,
  );
  const login = await call("/admin/api/login", "POST", { origin }, credentials);
  assert.equal(login.status, 200);
  const fullCookie = login.headers.get("set-cookie");
  assert.match(fullCookie, /Path=\/admin; Secure; HttpOnly; SameSite=Strict/);
  const cookie = fullCookie.split(";")[0];
  const context = await (
    await call("/admin/api/context", "GET", { cookie })
  ).json();
  const headers = { origin, cookie, [context.csrf_header]: context.csrf_token };
  const input = { site: "https://romm.example.test", token };
  assert.equal(
    (await call("/admin/api/integration", "PUT", { origin, cookie }, input))
      .status,
    403,
  );
  assert.equal(
    (
      await call(
        "/admin/api/integration",
        "PUT",
        { ...headers, origin: "https://other.example.test" },
        input,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/admin/api/integration", "PUT", headers, {
        ...input,
        site: "javascript:alert(1)",
      })
    ).status,
    400,
  );
  const saved = await call("/admin/api/integration", "PUT", headers, input);
  assert.deepEqual(await saved.json(), {
    site: input.site,
    tokenConfigured: true,
    lastRequestAt: null,
  });
  assert.equal((await call("/v1/rooms", "GET", { cookie })).status, 401);
  assert.equal(
    (await call("/admin/api", "GET", { authorization: `Bearer ${token}` }))
      .status,
    401,
  );
  assert.equal(
    (await call("/v1/rooms", "GET", { authorization: `Bearer ${token}` }))
      .status,
    200,
  );
  const overview = await (await call("/admin/api", "GET", { cookie })).json();
  assert.ok(overview.integration.lastRequestAt);
  assert.equal(JSON.stringify(overview).includes(token), false);
  assert.equal(
    (
      await call("/admin/api/integration", "PUT", headers, {
        ...input,
        token: replacement,
      })
    ).status,
    200,
  );
  assert.equal(
    (await call("/v1/rooms", "GET", { authorization: `Bearer ${token}` }))
      .status,
    401,
  );
  assert.equal(
    (await readFile(join(directory, "romm-integration.json"), "utf8")).includes(
      replacement,
    ),
    false,
  );
  assert.equal((await call("/admin/api/logout", "POST", headers)).status, 200);
  assert.equal((await call("/admin/api", "GET", { cookie })).status, 401);

  await bridge.close();
  bridge = await createBridge({ ...options, adminToken: token });
  assert.equal(
    (await call("/v1/rooms", "GET", { authorization: `Bearer ${token}` }))
      .status,
    401,
  );
  assert.equal(
    (await call("/v1/rooms", "GET", { authorization: `Bearer ${replacement}` }))
      .status,
    200,
  );
  assert.equal((await call("/admin/api", "GET", { cookie })).status, 401);
});

test("existing RomM deployments can leave standalone administration disabled", async (t) => {
  const bridge = await createBridge({ adminToken: token, logger() {} });
  t.after(() => bridge.close());
  const origin = `http://127.0.0.1:${bridge.address.port}`;
  assert.equal((await fetch(`${origin}/admin/`)).status, 404);
  assert.equal(
    (
      await fetch(`${origin}/v1/rooms/admin`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status,
    200,
  );
});
