import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [artifacts, output, prewarmText] = process.argv.slice(2);
const { default: init } = await import(
  pathToFileURL(path.join(artifacts, "core-probe.mjs"))
);
const module = await init({ print() {}, printErr() {} });
const reference = JSON.parse(
  await readFile(path.join(output, "reference.json")),
);
const rom = await readFile(path.join(output, "fixture.gba"));
const initial = await readFile(path.join(output, "initial.bin"));
const pointer = module._malloc(rom.length);
module.HEAPU8.set(rom, pointer);
assert.ok(module._probe_init(pointer, rom.length, reference.players));
for (let frame = 0; frame < Number(prewarmText); frame++)
  module._probe_step(0, 0, 0, 0);
const size = module._probe_size();
const statePointer = module._malloc(size);
const digest = (data) => createHash("sha256").update(data).digest("hex");
const save = () => {
  assert.ok(module._probe_save(statePointer, size));
  return Buffer.from(module.HEAPU8.slice(statePointer, statePointer + size));
};
const load = (data) => {
  module.HEAPU8.set(data, statePointer);
  assert.ok(module._probe_load(statePointer, data.length));
};
const step = (frame) =>
  module._probe_step(
    ...[0, 1, 2, 3].map((p) =>
      frame % (17 + p * 6) < 5 + p * 4 ? 1 << [8, 7, 6, 5][p] : 0,
    ),
  );
try {
  assert.equal(size, reference.size);
  load(initial);
  assert.deepEqual(save(), initial);
  const checkpoints = [];
  for (let frame = 0; frame < reference.frames; frame++) {
    step(frame);
    const state = save();
    assert.equal(
      digest(state),
      reference.hashes[frame],
      `Native/WASM frame ${frame}`,
    );
    if (frame % 97 === 0) checkpoints.push({ frame, state });
  }
  await writeFile(path.join(output, `wasm-final-${prewarmText}.bin`), save());
  for (const { frame, state } of checkpoints) {
    for (let prediction = 0; prediction < 12; prediction++) {
      module._probe_step(prediction % 2 ? 0xff : 0, 0x100, 0x80, 0x40);
    }
    load(state);
    for (
      let replay = frame + 1;
      replay < Math.min(reference.frames, frame + 71);
      replay++
    ) {
      step(replay);
      assert.equal(
        digest(save()),
        reference.hashes[replay],
        `WASM replay ${replay}`,
      );
    }
  }
  load(initial);
  const malformed = [
    initial.subarray(0, size - 1),
    initial.subarray(0, size - 48),
  ];
  for (const offset of [0, 4, 8]) {
    const state = Buffer.from(initial);
    state[offset] ^= 1;
    malformed.push(state);
  }
  const overflow = Buffer.from(initial);
  overflow.writeUInt32LE(size, 12);
  malformed.push(overflow);
  for (const state of malformed) {
    module.HEAPU8.set(state, statePointer);
    assert.equal(module._probe_load(statePointer, state.length), 0);
    assert.deepEqual(save(), initial);
  }
  for (const [slot, memoryId] of [0, 256, 257, 258]
    .slice(0, reference.players)
    .entries()) {
    assert.equal(module._probe_memory_size(memoryId), 131072);
    const address = module._probe_memory(memoryId);
    assert.ok(address);
    assert.equal(
      digest(module.HEAPU8.subarray(address + 0x100, address + 0x200)),
      reference.batteryHashes[slot],
    );
  }
  await writeFile(
    path.join(output, `wasm-${prewarmText}.json`),
    JSON.stringify(
      {
        size,
        prewarm: Number(prewarmText),
        frames: reference.frames,
        checkpoints: checkpoints.length,
        malformedRejected: malformed.length,
        crossPlatformReplay: true,
        batteryPreserved: true,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  module._probe_close();
  module._free(pointer);
  module._free(statePointer);
}
