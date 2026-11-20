import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBridge } from "../server.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const romm = resolve(
  process.env.ROMM_SOURCE || resolve(root, "../romm-netplay-publish"),
);
const { withHeadlessBrowser } = await import(
  pathToFileURL(resolve(romm, "scripts/headless-browser.mjs"))
);

const output = resolve(root, "../result/netplay-admin-ui-separated");
const serviceToken = "test-ui-service-token-at-least-24-characters";
const bridge = await createBridge({ adminToken: serviceToken, logger() {} });
const bridgeBase = `http://127.0.0.1:${bridge.address.port}/v1/rooms/admin/ui/`;
await mkdir(output, { recursive: true });
let role = "anonymous",
  failure = false,
  updates = 0;
let resources = {
  sampledAt: "2026-11-08T00:00:00Z",
  service: {
    scope: "container",
    cores: 1,
    cpuPercent: 12.5,
    usedBytes: 64 * 1024 ** 2,
    limitBytes: 256 * 1024 ** 2,
    memoryPercent: 25,
    network: {
      scope: "container",
      rxBytes: 42 * 1024 ** 2,
      txBytes: 10 * 1024 ** 2,
      rxBytesPerSecond: 2048,
      txBytesPerSecond: 4096,
    },
  },
};
const runtime = { roomsEnabled: true, maxRooms: 8, saveIntervalSeconds: 15 };
let network = { public_url: "", native_host: "" },
  pending = 1;
const events = [
  {
    id: 1,
    time: "2026-11-07T10:00:00Z",
    event: "native-connect",
    fields: { room: "fixture-room", player: 1 },
  },
  {
    id: 2,
    time: "2026-11-07T10:00:01Z",
    event: "save-error",
    fields: { reason: "<script>untrusted text</script>" },
  },
];
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://fixture");
  const reply = (status, value) =>
    response
      .writeHead(status, { "Content-Type": "application/json" })
      .end(JSON.stringify(value));
  assert.equal(request.headers.authorization, undefined);
  if (url.pathname.startsWith("/gateway/admin/ui/")) {
    if (role !== "admin")
      return reply(role === "anonymous" ? 401 : 403, {
        detail: "Administrator required",
      });
    const name =
      url.pathname.slice("/gateway/admin/ui/".length) || "index.html";
    const asset = await fetch(bridgeBase + name, {
      headers: { Authorization: `Bearer ${serviceToken}` },
    });
    response.writeHead(asset.status, {
      "Content-Type": asset.headers.get("content-type"),
      "Cache-Control": "no-store",
      "Set-Cookie": "fixture_csrf=fixture-csrf-value; Path=/; SameSite=Lax",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'",
    });
    return response.end(Buffer.from(await asset.arrayBuffer()));
  }
  if (url.pathname.startsWith("/gateway/admin")) {
    if (role !== "admin")
      return reply(role === "anonymous" ? 401 : 403, {
        detail: "Administrator required",
      });
    const path = url.pathname.slice("/gateway/admin".length);
    if (path === "/context")
      return reply(200, {
        application_name: "Fixture library",
        application_url: "/library/",
        csrf_cookie: "fixture_csrf",
        csrf_header: "x-fixture-csrf",
      });
    if (["PUT", "POST"].includes(request.method)) {
      assert.equal(request.headers["x-fixture-csrf"], "fixture-csrf-value");
    }
    if (request.method === "PUT") {
      let bytes = "";
      for await (const chunk of request) bytes += chunk;
      if (failure) return reply(502, { detail: "Bridge is unavailable" });
      updates++;
      const value = JSON.parse(bytes);
      if (path === "/settings") Object.assign(runtime, value);
      if (path === "/network") network = value;
      return reply(200, value);
    }
    if (path === "/logs")
      return reply(200, {
        startedAt: 1,
        cursor: 2,
        events: events.filter(
          (entry) => entry.id > Number(url.searchParams.get("after") || 0),
        ),
      });
    if (path === "/saves/sync") {
      pending = 0;
      return reply(200, { saved: 1, pending: 0 });
    }
    return reply(200, {
      username: "Fixture admin",
      public_url: network.public_url || "https://example.test:8443/bridge",
      native_host: network.native_host || "example.test",
      internal_url: "http://bridge:8080",
      network,
      defaults: {
        public_url: "https://example.test:8443/bridge",
        native_host: "example.test",
      },
      broker: {
        resources,
        settings: runtime,
        capacity: 8,
        persistent: true,
        uptimeSeconds: 30,
        transport: {
          nativePortStart: 55435,
          nativePortEnd: 55442,
          allowedOrigins: ["https://example.test:8443"],
        },
        rooms: [
          {
            id: "fixture-room",
            system: "gba",
            players: 2,
            current: 2,
            running: true,
            port: 55435,
          },
        ],
        saves: {
          enabled: true,
          pending,
          failed: pending,
          queue: pending
            ? [
                {
                  roomId: "fixture-room",
                  owner: "2",
                  romId: 12,
                  frame: 600,
                  error: "A temporary save error",
                },
              ]
            : [],
        },
      },
    });
  }
  return response.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  await withHeadlessBrowser(async (browser) => {
    for (const theme of ["light", "dark"]) {
      role = "anonymous";
      updates = 0;
      pending = 1;
      const context = await browser.newContext({
        viewport: { width: 1200, height: 950 },
        hasTouch: true,
      });
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const address = `http://127.0.0.1:${server.address().port}/gateway/admin/ui/`;
      assert.equal((await page.goto(address)).status(), 401);
      role = "user";
      assert.equal((await page.goto(address)).status(), 403);
      role = "admin";
      await page.goto(address);
      await page.locator("#dashboard").waitFor({ state: "visible" });
      assert.equal(
        await page.locator("#application-link").textContent(),
        "Open Fixture library",
      );
      role = "anonymous";
      await page.locator("#check-access").click();
      await page
        .locator("#access-title")
        .filter({ hasText: "Sign in" })
        .waitFor();
      assert(await page.locator("#dashboard").isHidden());
      role = "user";
      await page.locator("#check-access").click();
      await page
        .locator("#access-title")
        .filter({ hasText: "Administrator access required" })
        .waitFor();
      assert(await page.locator("#dashboard").isHidden());
      assert.equal(updates, 0);
      role = "admin";
      await page.locator("#check-access").click();
      await page.locator("#dashboard").waitFor({ state: "visible" });
      await page.selectOption("#theme", theme);
      await page.locator("#max-rooms").fill("4");
      await page.locator("#save-interval").fill("20");
      if (theme === "dark") await page.locator("#save-runtime").tap();
      else {
        await page.locator("#save-runtime").focus();
        await page.keyboard.press("Enter");
      }
      await page
        .locator("#admin-status")
        .filter({ hasText: "Multiplayer settings saved" })
        .waitFor();
      assert.equal(runtime.maxRooms, 4);
      assert.equal(runtime.saveIntervalSeconds, 20);
      await page.locator("#public-url").fill("https://changed.example/bridge");
      await page.locator('#network-form [type="submit"]').click();
      await page
        .locator("#admin-status")
        .filter({ hasText: "Connection addresses saved" })
        .waitFor();
      assert.equal(network.public_url, "https://changed.example/bridge");
      failure = true;
      await page.locator("#save-runtime").click();
      await page
        .locator("#admin-status")
        .filter({ hasText: "Bridge is unavailable" })
        .waitFor();
      failure = false;
      await page.locator("#sync-saves").click();
      await page
        .locator("#admin-status")
        .filter({ hasText: "synchronization completed" })
        .waitFor();
      assert.equal(pending, 0);
      await page.screenshot({
        path: resolve(output, `${theme}-settings.png`),
        fullPage: true,
      });
      for (const width of [320, 768, 3840]) {
        await page.setViewportSize({ width, height: 950 });
        assert(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          `Admin overflow at ${width}`,
        );
      }
      await page.setViewportSize({ width: 1200, height: 950 });
      await page.locator("#settings-tab").focus();
      await page.keyboard.press("ArrowRight");
      await page.locator("#log-entries li").first().waitFor();
      assert.equal(
        await page.locator("#logs-tab").getAttribute("aria-selected"),
        "true",
      );
      assert.equal(await page.locator("#log-entries script").count(), 0);
      assert.equal(
        await page.locator(".admin-resource-stats article").count(),
        3,
      );
      assert.equal(await page.locator("#host-cpu, #host-memory").count(), 0);
      assert(
        (await page.locator("#service-network").textContent()).includes(
          "2.0 KiB/s",
        ),
      );
      assert(
        (await page.locator("#service-network").textContent()).includes(
          "4.0 KiB/s",
        ),
      );
      assert(
        (await page.locator("#service-network-detail").textContent()).includes(
          "42.0 MiB",
        ),
      );
      assert.equal(await page.locator("#service-cpu").textContent(), "12.5%");
      assert.equal(
        await page.locator("#service-memory").textContent(),
        "64.0 MiB",
      );
      for (const width of [320, 768, 3840]) {
        await page.setViewportSize({ width, height: 950 });
        assert(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          `Resource overflow at ${width}`,
        );
      }
      await page.setViewportSize({ width: 1200, height: 950 });

      await page.locator("#log-search").fill("native-connect");
      assert.equal(await page.locator("#log-entries li").count(), 1);
      await page.locator("#log-search").fill("no-such-event");
      assert.equal(await page.locator("#log-entries li").count(), 0);
      await page.locator("#log-search").fill("");
      await page.screenshot({
        path: resolve(output, `${theme}-logs.png`),
        fullPage: true,
      });
      const downloaded = page.waitForEvent("download");
      await page.locator("#download-logs").click();
      assert.equal(
        (await downloaded).suggestedFilename(),
        "netplay-bridge-logs.jsonl",
      );
      const previousResources = resources;
      resources = {
        ...resources,
        service: { ...resources.service, network: null },
      };
      await page.locator("#refresh-logs").click();
      await page
        .locator("#service-network")
        .filter({ hasText: "Unavailable" })
        .waitFor();
      assert.equal(await page.locator("#service-cpu").textContent(), "12.5%");
      resources = undefined;
      await page.locator("#refresh-logs").click();
      await page
        .locator("#resource-updated")
        .filter({ hasText: "unavailable" })
        .waitFor();
      assert.equal(await page.locator("#service-network").textContent(), "—");
      resources = previousResources;
      role = "user";
      await page.locator("#refresh-logs").click();
      await page.locator("#access").waitFor({ state: "visible" });
      assert(await page.locator("#dashboard").isHidden());
      assert.equal(await page.locator("#log-entries li").count(), 0);
      assert.equal(await page.locator("#service-memory").textContent(), "—");
      assert.deepEqual(errors, []);
      await context.close();
    }
  });
  console.log(
    "Admin UI passed: role gates, settings persistence requests, sync action, filtered logs, safe text, revoked access, themes, keyboard/mouse/touch and responsive layouts; no emulator launched",
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  await bridge.close();
}
