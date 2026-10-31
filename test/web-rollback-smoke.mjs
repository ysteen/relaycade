/** Qualify two real WASM sessions against an independent replay oracle. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BridgeSession, crc32 } from "../client/bridge-session.js";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = process.env.NETPLAY_TEST_CORE ?? "sameboy";
const profiles = {
  sameboy: {
    name: "SameBoy",
    fixtures: ["link-1.gb", "link-2.gbc"],
    batteryIds: [256, 768],
    seedOffset: 0,
    seedLength: null,
    memoryData: "_retro_get_memory_data",
    memorySize: "_retro_get_memory_size",
  },
  mgba_splitscreen: {
    name: "mGBA Splitscreen",
    fixtures: ["gba-link-1.gba"],
    batteryIds: [0, 256],
    // The diagnostic ROM writes input/link telemetry below 0x40.
    seedOffset: 0x100,
    seedLength: 256,
    memoryData: "_probe_memory",
    memorySize: "_probe_memory_size",
  },
  snes9x: {
    name: "Snes9x",
    // Generate the original two-pad ROM with make-snes-fixture.py and pass
    // its path explicitly. Both joypads control one console and one save.
    fixtures: [],
    batteryIds: [0],
    sharedBattery: true,
    seedOffset: 0x100,
    seedLength: 256,
    memoryData: "_probe_memory",
    memorySize: "_probe_memory_size",
    telemetry: { memoryId: 0, heldCountOffset: 6 },
  },
};
const profile = profiles[core];
if (!profile) throw new Error(`Unsupported core profile: ${core}`);
const artifacts = process.env.NETPLAY_TEST_ARTIFACTS;
const wasmPath =
  process.env.NETPLAY_TEST_WASM ??
  (artifacts ? resolve(artifacts, "core-probe.mjs") : null);
if (!wasmPath)
  throw new Error("Set NETPLAY_TEST_WASM or NETPLAY_TEST_ARTIFACTS");
const output = resolve(
  process.env.NETPLAY_TEST_OUTPUT ??
    resolve(dirname(wasmPath), "web-rollback-smoke"),
);
const frames = Number(process.env.NETPLAY_TEST_FRAMES ?? 600);
const maxPrediction = Number(process.env.NETPLAY_TEST_MAX_PREDICTION ?? 12);
const latency = Number(process.env.NETPLAY_TEST_INPUT_LATENCY_FRAMES ?? 4);
const jitter = Number(process.env.NETPLAY_TEST_JITTER_FRAMES ?? 4);
const inputDelay = 2;
const batterySeed =
  process.env.NETPLAY_TEST_BATTERY_SEED === undefined
    ? null
    : Number(process.env.NETPLAY_TEST_BATTERY_SEED);
if (
  batterySeed !== null &&
  (!Number.isInteger(batterySeed) || batterySeed < 0 || batterySeed > 255)
)
  throw new Error("Invalid battery seed");
for (const [name, value, min, max] of [
  ["frames", frames, 60, 120000],
  ["maxPrediction", maxPrediction, 1, 30],
  ["latency", latency, 1, 60],
  ["jitter", jitter, 0, 30],
]) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${name}`);
}
const romPaths = process.argv.slice(2).length
  ? process.argv.slice(2)
  : profile.fixtures.map((name) => resolve(repository, "test/fixtures", name));
if (!romPaths.length)
  throw new Error(`Pass a diagnostic ROM path for ${profile.name}`);
const { default: init } = await import(pathToFileURL(resolve(wasmPath)));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const buttons = (frame, player) =>
  frame < inputDelay
    ? 0
    : (frame % (17 + player * 6) < 6 ? 256 : 0) |
      (frame % (29 + player * 4) < 9 ? 1 : 0);

async function adapterFor(rom) {
  const module = await init({ print() {}, printErr() {} });
  const romPointer = module._malloc(rom.length);
  if (!romPointer) throw new Error("ROM allocation failed");
  module.HEAPU8.set(rom, romPointer);
  if (!module._probe_init(romPointer, rom.length, 2))
    throw new Error("Core init failed");
  module._probe_step(0, 0, 0, 0);
  const size = module._probe_size(),
    pointer = module._malloc(size);
  assert.ok(size > 0 && size <= 16 * 1024 * 1024 && pointer);
  return {
    size,
    presented: 0,
    replayed: 0,
    save() {
      assert.ok(module._probe_save(pointer, size), "Core save failed");
      return module.HEAPU8.slice(pointer, pointer + size);
    },
    load(bytes) {
      assert.equal(bytes.length, size);
      module.HEAPU8.set(bytes, pointer);
      assert.ok(module._probe_load(pointer, size), "Core restore failed");
    },
    step(a, b, present = true) {
      module._probe_step(a, b, 0, 0);
      if (present) this.presented++;
      else this.replayed++;
    },
    memory(id) {
      if (!module[profile.memoryData] || !module[profile.memorySize])
        throw new Error("Battery checks require probe memory exports");
      const length = module[profile.memorySize](id);
      const start = module[profile.memoryData](id);
      assert.ok(start && length, `Battery memory ${id} unavailable`);
      return module.HEAPU8.slice(start, start + length);
    },
    loadMemory(id, bytes) {
      assert.equal(module[profile.memorySize](id), bytes.length);
      module.HEAPU8.set(bytes, module[profile.memoryData](id));
    },
    close() {
      module._probe_close();
      module._free(pointer);
      module._free(romPointer);
    },
  };
}

async function qualify(romPath) {
  const started = performance.now(),
    rom = await readFile(romPath);
  const adapters = [];
  let diagnostics = {};
  try {
    for (let i = 0; i < 3; i++) adapters.push(await adapterFor(rom));
    const batteries =
      batterySeed === null
        ? []
        : profile.batteryIds.map((id, player) => {
            const bytes = adapters[0].memory(id);
            assert.ok(
              bytes.length,
              "Battery seeding requires a fixture with cartridge RAM",
            );
            const offset = profile.seedOffset;
            const length = profile.seedLength ?? bytes.length;
            assert.ok(offset + length <= bytes.length);
            for (let i = 0; i < length; i++)
              bytes[offset + i] = (batterySeed + player * 64 + i * 7) & 255;
            adapters[0].loadMemory(id, bytes);
            return {
              id,
              size: bytes.length,
              offset,
              bytes: bytes.slice(offset, offset + length),
            };
          });
    const initial = adapters[0].save();
    if (core === "mgba_splitscreen") {
      const header = new DataView(initial.buffer, initial.byteOffset);
      assert.equal(
        header.getUint32(0, true),
        0x54535053,
        "Expected SPST magic",
      );
      assert.equal(
        header.getUint32(4, true),
        4,
        "Expected SPST4 rollback state",
      );
      assert.equal(header.getUint32(8, true), 2, "Expected two players");
    }
    await writeFile(
      resolve(output, `${basename(romPath)}-initial.bin`),
      initial,
    );
    for (const adapter of adapters) {
      adapter.load(initial);
      assert.deepEqual(adapter.save(), initial, "Initial state round trip");
    }
    const oracle = adapters[2],
      oracleStates = new Map([[0, initial]]);
    const oracleBatteries = new Map([
      [0, batteries.map(({ id }) => oracle.memory(id))],
    ]);
    const checkpoints = [{ frame: 0, state: initial }];
    const ablationStart = Math.floor(frames / 3);
    const ablationEnd = Math.min(frames, ablationStart + 60);
    let ablationTelemetry = null;
    const oracleHashes = [hash(initial)];
    const checkpointFrames = new Set([
      Math.floor(frames / 3),
      Math.floor((2 * frames) / 3),
    ]);
    const queues = [[], []],
      due = [0, 0],
      verified = [0, 0];
    const inputCounts = [0, 0],
      nonzeroInputs = [0, 0],
      batteryChecks = [0, 0],
      checks = [[], []];
    const assertBatterySeed = (memory, battery) =>
      assert.deepEqual(
        memory.subarray(battery.offset, battery.offset + battery.bytes.length),
        battery.bytes,
        `Battery seed changed for memory ${battery.id}`,
      );
    let turn = 0,
      oracleFrame = 0,
      comparisons = 0,
      maxQueued = 0;
    const sessions = adapters.slice(0, 2).map(
      (adapter, player) =>
        new BridgeSession(adapter, {
          player,
          players: 2,
          inputDelay,
          maxPrediction,
          send(packet) {
            if (packet.t === "input") {
              inputCounts[player]++;
              if (packet.b) nonzeroInputs[player]++;
              const peer = 1 - player;
              due[peer] = Math.max(
                due[peer],
                turn + latency + ((packet.f * 7 + player * 3) % (jitter + 1)),
              );
              queues[peer].push({ ...packet, player, due: due[peer] });
              maxQueued = Math.max(maxQueued, queues[peer].length);
            } else if (packet.t === "crc") checks[player].push(packet);
          },
        }),
    );
    const verify = async (player) => {
      const session = sessions[player];
      while (verified[player] < session.confirmed) {
        const f = ++verified[player];
        while (oracleFrame < f) {
          oracle.step(buttons(oracleFrame, 0), buttons(oracleFrame, 1));
          oracleFrame++;
          const state = oracle.save();
          oracleStates.set(oracleFrame, state);
          if (batteries.length)
            oracleBatteries.set(
              oracleFrame,
              batteries.map(({ id }) => oracle.memory(id)),
            );
          oracleHashes[oracleFrame] = hash(state);
          if (profile.telemetry && oracleFrame === ablationEnd)
            ablationTelemetry = oracle.memory(profile.telemetry.memoryId);
          if (checkpointFrames.has(oracleFrame))
            checkpoints.push({ frame: oracleFrame, state });
        }
        const expected = oracleStates.get(f);
        assert.ok(expected, `Oracle history missing frame ${f}`);
        const actual = session.stateAt(f);
        if (!Buffer.from(actual).equals(expected)) {
          const failure = resolve(
            output,
            `${basename(romPath)}-mismatch-${player}-${f}`,
          );
          await Promise.all([
            writeFile(`${failure}-actual.bin`, actual),
            writeFile(`${failure}-expected.bin`, expected),
          ]);
          throw new Error(
            `State mismatch at player ${player} frame ${f}: ${hash(actual)} != ${hash(expected)} (${failure})`,
          );
        }
        comparisons++;
      }
      const batteryCheckpoint = Math.floor(session.confirmed / 60);
      if (batteries.length && batteryCheckpoint > batteryChecks[player]) {
        // Peers confirm at different rates. Keep the oracle's original run
        // untouched while comparing each peer's exact confirmed SRAM.
        const expected = oracleBatteries.get(session.confirmed);
        for (const [slot, battery] of batteries.entries()) {
          const memory = session.confirmedMemory(battery.id);
          assert.deepEqual(
            memory,
            expected[slot],
            "Confirmed battery differs from baseline",
          );
          assertBatterySeed(memory, battery);
        }
        batteryChecks[player] = batteryCheckpoint;
      }
      const oldest = Math.min(...verified);
      for (const f of oracleStates.keys())
        if (f < oldest) {
          oracleStates.delete(f);
          oracleBatteries.delete(f);
        }
      assert.ok(
        oracleStates.size <= 2 * maxPrediction + 2 * inputDelay + 16,
        "Oracle history unbounded",
      );
      assert.ok(session.frame - session.confirmed <= maxPrediction);
      assert.ok(session.snapshots.size <= maxPrediction + 8);
    };
    diagnostics = {
      frames,
      stats: sessions.map((session) => session.stats),
      inputCounts,
      nonzeroInputs,
    };
    sessions.forEach((session) => session.start());
    for (
      ;
      turn < frames * 20 + 100 && sessions.some((s) => s.confirmed < frames);
      turn++
    ) {
      for (let player = 0; player < 2; player++) {
        while (queues[player][0]?.due <= turn) {
          sessions[player].receive(queues[player].shift());
          await verify(player);
        }
        const session = sessions[player];
        if (session.frame < frames)
          session.tick(buttons(session.frame + inputDelay, player));
        await verify(player);
      }
    }
    assert.ok(
      sessions.every((s) => s.frame === frames && s.confirmed === frames),
      "Sessions failed to finish",
    );
    assert.ok(
      sessions.every(
        (s) => s.stats.rollbacks > 0 && s.stats.replayedFrames > 0,
      ),
      "No rollback observed",
    );
    assert.ok(
      nonzeroInputs.every((count) => count > 0),
      "Missing nonzero player input",
    );
    for (const [player, session] of sessions.entries()) {
      assert.equal(
        adapters[player].presented,
        frames,
        "Repeated presentation during rollback",
      );
      assert.equal(
        adapters[player].replayed,
        session.stats.replayedFrames,
        "Rollback presentation was not suppressed",
      );
    }
    const final = oracle.save();
    for (const adapter of adapters)
      for (const battery of batteries) {
        const memory = adapter.memory(battery.id);
        assert.deepEqual(
          memory,
          oracle.memory(battery.id),
          "Final battery differs from baseline",
        );
        assertBatterySeed(memory, battery);
      }
    assert.deepEqual(adapters[0].save(), final);
    assert.deepEqual(adapters[1].save(), final);
    assert.deepEqual(checks[0], checks[1]);
    assert.equal(checks[0].length, Math.floor(frames / 60));
    const finalCheckpoint = checks[0].find((check) => check.f === frames);
    if (finalCheckpoint) assert.equal(finalCheckpoint.crc, crc32(final));
    let restoredFrames = 0;
    for (const checkpoint of checkpoints) {
      for (const adapter of adapters) {
        // Deliberately poison input history before restoration. A replay that
        // only restores after matching inputs can miss unsaved joypad state.
        for (let prediction = 0; prediction < maxPrediction; prediction++)
          adapter.step(prediction % 2 ? 0xff : 0, 0x100, false);
        adapter.load(checkpoint.state);
        assert.deepEqual(
          adapter.save(),
          checkpoint.state,
          "Checkpoint round trip",
        );
      }
      for (
        let f = checkpoint.frame;
        f < Math.min(frames, checkpoint.frame + 60);
        f++
      ) {
        for (const adapter of adapters)
          adapter.step(buttons(f, 0), buttons(f, 1), false);
        assert.deepEqual(
          adapters[0].save(),
          oracle.save(),
          `Restored replay mismatch at ${f + 1}`,
        );
        assert.deepEqual(
          adapters[1].save(),
          oracle.save(),
          `Restored replay mismatch at ${f + 1}`,
        );
        for (const adapter of adapters)
          assert.equal(
            hash(adapter.save()),
            oracleHashes[f + 1],
            `Replay differs from original frame ${f + 1}`,
          );
        restoredFrames++;
      }
    }
    const inputEffects = [];
    const inputHeldCountEffects = [];
    const inputCheckpoint = checkpoints[1];
    assert.equal(inputCheckpoint.frame, ablationStart);
    for (let player = 0; player < 2; player++) {
      oracle.load(inputCheckpoint.state);
      let differingFrames = 0;
      for (let f = inputCheckpoint.frame; f < ablationEnd; f++) {
        oracle.step(
          player === 0 ? 0 : buttons(f, 0),
          player === 1 ? 0 : buttons(f, 1),
          false,
        );
        if (hash(oracle.save()) !== oracleHashes[f + 1]) differingFrames++;
      }
      assert.ok(
        differingFrames > 0,
        `Player ${player} input has no observable state effect`,
      );
      inputEffects.push(differingFrames);
      if (profile.telemetry) {
        const offset = profile.telemetry.heldCountOffset + player;
        const actual = oracle.memory(profile.telemetry.memoryId);
        const omitted = (ablationTelemetry[offset] - actual[offset]) & 255;
        assert.ok(
          omitted > 0 && omitted <= ablationEnd - ablationStart,
          `Player ${player} input has no effect on the fixture's SRAM held counter`,
        );
        inputHeldCountEffects.push(omitted);
      }
    }
    for (const adapter of adapters) {
      adapter.load(final);
      assert.deepEqual(adapter.save(), final, "Final state round trip");
    }
    await writeFile(
      resolve(output, `${basename(romPath)}-initial.bin`),
      initial,
    );
    await writeFile(resolve(output, `${basename(romPath)}-final.bin`), final);
    return {
      passed: true,
      core,
      players: 2,
      rom: resolve(romPath),
      romSha256: hash(rom),
      frames,
      stateSize: initial.length,
      finalSha256: hash(final),
      comparisons,
      rollbackStats: sessions.map((s) => s.stats),
      inputCounts,
      nonzeroInputs,
      inputAffectsState: inputEffects.map((count) => count > 0),
      inputAblationDifferingFrames: inputEffects,
      inputAblationHeldCountDifferences: inputHeldCountEffects,
      confirmed: sessions.map((s) => s.confirmed),
      checks: checks[0].length,
      maxPrediction,
      inputDelay,
      latencyFrames: latency,
      jitterFrames: jitter,
      schedulerTurns: turn,
      maxQueued,
      restoredCheckpoints: checkpoints.length,
      restoredFrames,
      wrongPredictionFrames: checkpoints.length * maxPrediction,
      batteryPreserved: batteries.length ? true : null,
      batteryScope: profile.sharedBattery ? "shared" : "per-player",
      batteryBytes: batteries.map(({ size }) => size),
      batterySeedBytes: batteries.map(({ bytes }) => bytes.length),
      confirmedBatteryChecks: batteryChecks,
      elapsedSeconds: (performance.now() - started) / 1000,
      scope: `Real ${profile.name} WASM and BridgeSession with simulated ordered transport; not browser rendering, TCP, native RetroArch or commercial-game qualification`,
    };
  } catch (error) {
    error.details = diagnostics;
    throw error;
  } finally {
    for (const adapter of adapters) adapter.close();
  }
}

await mkdir(output, { recursive: true });
const results = [];
for (const romPath of romPaths) {
  try {
    const result = await qualify(romPath);
    results.push(result);
    console.log(JSON.stringify(result));
  } catch (error) {
    results.push({
      passed: false,
      rom: resolve(romPath),
      error: error.stack,
      details: error.details,
    });
    process.exitCode = 1;
    console.error(error.stack);
    break;
  } finally {
    await writeFile(
      resolve(output, "result.json"),
      JSON.stringify({ core, wasmPath: resolve(wasmPath), results }, null, 2) +
        "\n",
    );
  }
}
