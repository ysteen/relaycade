import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

assert.equal(process.platform, "win32", "Use the bounded Windows runner");
const work = resolve(process.argv[2]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const name of ["mgba", "sameboy"]) {
  const { default: init } = await import(
    pathToFileURL(resolve(work, name, "core-probe.mjs"))
  );
  const rom = await readFile(
    resolve(work, name === "mgba" ? "gba-link-1.gba" : "link-1.gb"),
  );
  for (let players = 2; players <= (name === "mgba" ? 4 : 2); players++) {
    const core = await init({ print() {}, printErr() {} });
    const romPointer = core._malloc(rom.length);
    core.HEAPU8.set(rom, romPointer);
    assert(core._probe_init(romPointer, rom.length, players));
    const full = (1 << players) - 1;
    const step = (mask, frame) => {
      const keys = Array.from(
        { length: 4 },
        (_, i) =>
          (mask & (1 << i) ? 0 : 0x8000) | ((frame + i) % 7 === 0 ? 0x100 : 0),
      );
      core._probe_step(...keys);
    };
    for (let frame = 0; frame < 180; frame++) step(full, frame);
    const size = core._probe_size(),
      pointer = core._malloc(size);
    const save = () => {
      assert(core._probe_save(pointer, size));
      return core.HEAPU8.slice(pointer, pointer + size);
    };
    const load = (state) => {
      core.HEAPU8.set(state, pointer);
      assert(core._probe_load(pointer, size));
    };
    try {
      // SameBoy initializes RAM randomly; netplay starts from one shared snapshot.
      load(
        await readFile(resolve(work, name, `state-p${players}-initial.bin`)),
      );
      for (let mask = 0; mask <= full; mask++) {
        const before = save();
        for (let frame = 0; frame < 12; frame++) step(mask, frame);
        const after = save();
        const native = await readFile(
          resolve(work, name, `state-p${players}-mask${mask}.bin`),
        );
        if (hash(after) !== hash(native))
          await writeFile(
            resolve(work, `${name}-p${players}-mask${mask}-wasm.bin`),
            after,
          );
        assert.equal(
          hash(after),
          hash(native),
          `${name} ${players} players, mask ${mask}: native/WASM differ`,
        );
        load(before);
        for (let frame = 0; frame < 12; frame++) step(mask, frame);
        assert.equal(
          hash(save()),
          hash(after),
          `${name} cable rollback differs`,
        );
        step(full ^ mask, 0);
        load(native);
        assert.equal(
          hash(save()),
          hash(native),
          `${name} disconnected native snapshot differs`,
        );
        for (let frame = 0; frame < 8; frame++) step(full, frame);
      }
      console.log(
        JSON.stringify({
          core: name,
          players,
          masks: full + 1,
          nativeWasmEqual: true,
          rollbackEqual: true,
        }),
      );
    } finally {
      core._probe_close();
      core._free(pointer);
      core._free(romPointer);
    }
  }
}
