import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, extname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
const integrationRoot = resolve(
  process.env.ROMM_SOURCE ?? "../romm-retroarch-sync",
);
const { withHeadlessBrowser } = await import(
  pathToFileURL(resolve(integrationRoot, "scripts/headless-browser.mjs"))
);

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreName = process.env.NETPLAY_TEST_CORE ?? "sameboy";
assert.ok(["sameboy", "mgba_splitscreen", "snes9x"].includes(coreName));
const gba = coreName === "mgba_splitscreen";
const snes = coreName === "snes9x";
const family = snes
  ? "snes-rollback"
  : gba
    ? "mgba-rollback"
    : "sameboy-rollback";
const build = snes ? "stock-web" : gba ? "v4-web" : "sbr2-web";
const artifacts = resolve(
  process.env.NETPLAY_TEST_PATCHED_ARTIFACTS ??
    `../result/netplay-interop/${family}/${build}`,
);
const output = resolve(
  process.env.NETPLAY_TEST_OUTPUT ??
    `../result/netplay-interop/${family}/browser`,
);
const frames = Number(process.env.NETPLAY_TEST_FRAMES ?? 600);
assert.ok(Number.isInteger(frames) && frames >= 180);
await mkdir(output, { recursive: true });
const rom = await readFile(
  resolve(
    process.env.NETPLAY_TEST_ROM ??
      (snes
        ? resolve(repo, "test/fixtures/two-pad.sfc")
        : resolve(repo, "test/fixtures", gba ? "gba-link-1.gba" : "link-1.gb")),
  ),
);
const pack = await readFile(resolve(artifacts, `web/${coreName}-wasm.data`));
const { default: init } = await import(
  pathToFileURL(resolve(artifacts, "core-probe.mjs"))
);
const oracle = await init({ print() {}, printErr() {} });
const romPointer = oracle._malloc(rom.length);
oracle.HEAPU8.set(rom, romPointer);
assert.ok(oracle._probe_init(romPointer, rom.length, 2));
oracle._probe_step(0, 0, 0, 0);
const size = oracle._probe_size(),
  statePointer = oracle._malloc(size);
const hash = (data) => createHash("sha256").update(data).digest("hex");
const buttons = (frame, player) =>
  frame < 2
    ? 0
    : player === 0
      ? frame % 17 < 5
        ? 256
        : 0
      : frame % 23 < 9
        ? 128
        : 0;
const errors = [];
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
try {
  await withHeadlessBrowser(
    async (browser) => {
      const context = await browser.newContext({
        viewport: { width: 800, height: 500 },
      });
      await context.addInitScript(() => {
        // Match bridge.js: a background tab may legitimately deny a wake lock.
        const wakeLock = navigator.wakeLock;
        if (wakeLock) {
          const request = wakeLock.request.bind(wakeLock);
          wakeLock.request = (...args) => {
            const pending = request(...args);
            pending.catch(() => {});
            return pending;
          };
        }
        window.audioEvents = 0;
        const original = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function (...args) {
          window.audioEvents++;
          return original.apply(this, args);
        };
      });
      await context.route(
        "http://127.0.0.1:8081/assets/emulatorjs/**",
        async (route) => {
          const relative = decodeURIComponent(
            new URL(route.request().url()).pathname,
          ).replace("/assets/emulatorjs/", "");
          if (relative === `data/cores/${coreName}-wasm.data`)
            return route.fulfill({
              body: pack,
              contentType: "application/octet-stream",
            });
          if (relative === `data/cores/${coreName}.json`)
            return route.fulfill({
              contentType: "application/json",
              body: JSON.stringify({
                core: coreName,
                buildStart: hash(pack),
                options: { defaultWebGL2: true },
              }),
            });
          const asset = resolve(integrationRoot, "custom-emulatorjs", relative);
          if (
            !asset.startsWith(
              resolve(integrationRoot, "custom-emulatorjs") + sep,
            )
          )
            return route.fulfill({ status: 403 });
          try {
            await route.fulfill({
              body: await readFile(asset),
              contentType: types[extname(asset)] ?? "application/octet-stream",
            });
          } catch {
            await route.fulfill({ status: 404, body: "Missing test asset" });
          }
        },
      );
      const pages = [];
      for (let player = 0; player < 2; player++) {
        const page = await context.newPage();
        page.on("pageerror", (error) =>
          errors.push({ player, error: error.message }),
        );
        await page.goto(
          "http://127.0.0.1:8081/assets/emulatorjs/input-netplay/player.html",
        );
        await page.waitForFunction(() => typeof window.boot === "function");
        await page.evaluate(
          async ({ bytes, coreName, gba }) => {
            const { linkCore } =
              await import("../data/src/link-core.js?v=20261021.10");
            const cartridge = Uint8Array.from(bytes);
            if (coreName === "snes9x") {
              const { bindPlayerVolume } =
                await import("./audio.js?v=20261021.10");
              const url = URL.createObjectURL(new Blob([cartridge]));
              try {
                await new Promise((resolve, reject) => {
                  const timeout = setTimeout(
                    () => reject(new Error("Snes9x startup timed out")),
                    45000,
                  );
                  Object.assign(window, {
                    EJS_player: "#game",
                    EJS_core: "snes9x",
                    EJS_gameUrl: url,
                    EJS_gameName: "two-pad.sfc",
                    EJS_pathtodata: "../data/",
                    EJS_startOnLoaded: true,
                    EJS_threads: false,
                    EJS_DEBUG_XX: true,
                    EJS_dontExtractRom: true,
                    EJS_disableLocalStorage: true,
                    EJS_cacheConfig: { enabled: false },
                    EJS_volume: 0.4,
                    EJS_noAutoFocus: true,
                    EJS_paths: {
                      "snes9x-wasm.data":
                        "/assets/emulatorjs/data/cores/snes9x-wasm.data",
                      "snes9x.json":
                        "/assets/emulatorjs/data/cores/snes9x.json",
                    },
                    EJS_defaultOptions: {
                      snes9x_region: "auto",
                      snes9x_overclock_superfx: "100%",
                      snes9x_overclock_cycles: "disabled",
                      snes9x_up_down_allowed: "disabled",
                      snes9x_audio_interpolation: "gaussian",
                      snes9x_blargg: "disabled",
                      snes9x_randomize_memory: "disabled",
                    },
                    EJS_onGameStart() {
                      try {
                        const module = EJS_emulator.Module;
                        if (!module._ejs_sync_begin())
                          throw new Error("Snes9x sync initialization failed");
                        module._ejs_sync_step(0, 0, 1);
                        const size = module._ejs_sync_state_size(),
                          pointer = module._malloc(size);
                        if (!size || !pointer)
                          throw new Error("Snes9x state allocation failed");
                        window.adapter = {
                          size,
                          memoryIds: [0],
                          step(a, b, present = true) {
                            if (!module._ejs_sync_step(a, b, Number(present)))
                              throw new Error("Snes9x frame failed");
                          },
                          save() {
                            if (!module._ejs_sync_save(pointer, size))
                              throw new Error("Snes9x state save failed");
                            return module.HEAPU8.slice(pointer, pointer + size);
                          },
                          load(bytes) {
                            if (bytes.length !== size)
                              throw new Error("Snes9x state size mismatch");
                            module.HEAPU8.set(bytes, pointer);
                            if (!module._ejs_sync_load(pointer, size))
                              throw new Error("Snes9x state load failed");
                          },
                        };
                        bindPlayerVolume(EJS_emulator, window.audioOutput);
                        window.audioOutput.setActive(true);
                        clearTimeout(timeout);
                        resolve();
                      } catch (error) {
                        clearTimeout(timeout);
                        reject(error);
                      }
                    },
                  });
                  const script = document.createElement("script");
                  script.src = "../data/loader.js?v=20261021.10";
                  script.onerror = () => {
                    clearTimeout(timeout);
                    reject(new Error("Snes9x loader failed"));
                  };
                  document.body.append(script);
                });
              } finally {
                URL.revokeObjectURL(url);
              }
              return;
            }
            window.adapter = await window.boot(
              [cartridge, cartridge],
              linkCore(coreName).options,
              {
                core: coreName,
                waitForCoreInitialization: gba,
                paths: {
                  [`${coreName}-wasm.data`]: `/assets/emulatorjs/data/cores/${coreName}-wasm.data`,
                  [`${coreName}.json`]: `/assets/emulatorjs/data/cores/${coreName}.json`,
                },
              },
            );
            window.audioOutput.setActive(true);
          },
          { bytes: Array.from(rom), coreName, gba },
        );
        pages.push(page);
      }
      let visualInputColors = null;
      if (snes) {
        visualInputColors = await pages[0].evaluate(() => {
          const before = window.adapter.save();
          const colors = [];
          try {
            for (const [p1, p2] of [
              [0, 0],
              [256, 0],
              [0, 256],
            ]) {
              window.adapter.load(before);
              for (let frame = 0; frame < 6; frame++)
                window.adapter.step(p1, p2, true);
              const canvas = EJS_emulator.canvas;
              const gl =
                canvas.getContext("webgl2") ?? canvas.getContext("webgl");
              if (!gl) throw new Error("Expected a WebGL canvas");
              const pixel = new Uint8Array(4);
              gl.readPixels(
                Math.floor(canvas.width / 2),
                Math.floor(canvas.height / 2),
                1,
                1,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                pixel,
              );
              colors.push(Array.from(pixel));
            }
          } finally {
            window.adapter.load(before);
          }
          return colors;
        });
        assert.notDeepEqual(
          visualInputColors[0],
          visualInputColors[1],
          "P1 must change the rendered backdrop",
        );
        assert.notDeepEqual(
          visualInputColors[0],
          visualInputColors[2],
          "P2 must change the rendered backdrop",
        );
      }
      const initial = Buffer.from(
        await pages[0].evaluate(() => Array.from(window.adapter.save())),
      );
      assert.equal(initial.length, size);
      oracle.HEAPU8.set(initial, statePointer);
      assert.ok(oracle._probe_load(statePointer, size));
      const expected = new Map();
      for (let frame = 0; frame < frames; frame++) {
        oracle._probe_step(buttons(frame, 0), buttons(frame, 1), 0, 0);
        assert.ok(oracle._probe_save(statePointer, size));
        expected.set(
          frame + 1,
          hash(oracle.HEAPU8.subarray(statePointer, statePointer + size)),
        );
      }
      for (let player = 0; player < 2; player++) {
        await pages[player].evaluate(
          async ({ initial, player, frames }) => {
            const { BridgeSession } =
              await import("../data/src/bridge-session.js");
            window.adapter.load(Uint8Array.from(initial));
            window.packets = [];
            window.verifiedFrame = 0;
            window.session = new BridgeSession(window.adapter, {
              player,
              players: 2,
              inputDelay: 2,
              maxPrediction: 12,
              send: (packet) => window.packets.push(packet),
            });
            window.session.start();
            window.advance = async (incoming) => {
              const states = [];
              const verify = async () => {
                while (window.verifiedFrame < window.session.confirmed) {
                  const frame = ++window.verifiedFrame;
                  const data = window.session.stateAt(frame);
                  const digest = new Uint8Array(
                    await crypto.subtle.digest("SHA-256", data),
                  );
                  states.push({
                    frame,
                    hash: Array.from(digest, (x) =>
                      x.toString(16).padStart(2, "0"),
                    ).join(""),
                  });
                }
              };
              for (const packet of incoming) {
                window.session.receive(packet);
                await verify();
              }
              if (window.session.frame < frames) {
                const f = window.session.frame + 2;
                const b =
                  player === 0 ? (f % 17 < 5 ? 256 : 0) : f % 23 < 9 ? 128 : 0;
                window.session.tick(b);
              }
              await verify();
              const packets = window.packets.splice(0);
              return {
                packets,
                states,
                frame: window.session.frame,
                confirmed: window.session.confirmed,
                stats: window.session.stats,
              };
            };
          },
          { initial: Array.from(initial), player, frames },
        );
      }
      const queues = [[], []],
        due = [0, 0],
        final = [null, null];
      let comparisons = 0;
      for (
        let turn = 0;
        turn < frames * 10 && final.some((x) => x?.confirmed !== frames);
        turn++
      ) {
        for (let player = 0; player < 2; player++) {
          const incoming = [];
          while (queues[player][0]?.due <= turn)
            incoming.push(queues[player].shift().packet);
          const result = await pages[player].evaluate(
            (packets) => window.advance(packets),
            incoming,
          );
          for (const state of result.states) {
            assert.equal(
              state.hash,
              expected.get(state.frame),
              `Browser ${player}, confirmed frame ${state.frame}`,
            );
            comparisons++;
          }
          for (const packet of result.packets.filter((x) => x.t === "input")) {
            const peer = 1 - player;
            due[peer] = Math.max(due[peer], turn + 4 + (packet.f % 4));
            queues[peer].push({
              due: due[peer],
              packet: { ...packet, player },
            });
          }
          final[player] = result;
        }
        if (turn % 8 === 0) await delay(10);
      }
      assert.equal(comparisons, 2 * frames);
      for (let player = 0; player < 2; player++) {
        assert.equal(final[player].frame, frames);
        assert.equal(final[player].confirmed, frames);
        assert.ok(final[player].stats.rollbacks > 0);
        assert.ok(final[player].stats.replayedFrames > 0);
        await pages[player].screenshot({
          path: resolve(output, `player-${player}.png`),
        });
        final[player].render = await pages[player].evaluate(() => ({
          width: EJS_emulator.canvas.width,
          height: EJS_emulator.canvas.height,
          audio: window.audioOutput.outputs,
          audioEvents: window.audioEvents,
        }));
        assert.ok(
          final[player].render.width > 0 && final[player].render.height > 0,
        );
        assert.ok(
          final[player].render.audio.some((x) => x.state === "running"),
        );
        delete final[player].packets;
        delete final[player].states;
      }
      assert.deepEqual(errors, []);
      const report = {
        frames,
        size,
        comparisons,
        core: snes
          ? "Snes9x 2d4cce69"
          : gba
            ? "mGBA Splitscreen SPST4"
            : "SameBoy SBR2",
        mediaStreaming: false,
        visualInputColors,
        transport: "deterministic delayed input harness",
        players: final,
        errors,
      };
      await writeFile(
        resolve(output, "result.json"),
        JSON.stringify(report, null, 2) + "\n",
      );
      console.log(JSON.stringify(report, null, 2));
    },
    {
      args: [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  );
} finally {
  oracle._probe_close();
  oracle._free(romPointer);
  oracle._free(statePointer);
}
