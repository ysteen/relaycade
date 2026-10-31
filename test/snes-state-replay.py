#!/usr/bin/env python3
"""Qualify Snes9x native/WASM state restoration with diagnostic ROMs."""

import argparse
import ctypes as c
import hashlib
import json
import subprocess
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inputs(frame):
    return (256 if frame % 17 < 5 else 0, 128 if frame % 23 < 9 else 0)


def qualify(artifacts, rom_path, output, frames, prewarm):
    output.mkdir(parents=True, exist_ok=False)
    rom = rom_path.read_bytes()
    (output / "fixture.sfc").write_bytes(rom)
    core = c.CDLL(str(artifacts / "native-probe.so"))
    core.probe_init.argtypes = [c.c_void_p, c.c_size_t]
    core.probe_size.restype = c.c_size_t
    core.probe_save.argtypes = core.probe_load.argtypes = [c.c_void_p, c.c_size_t]
    core.probe_memory.argtypes = [c.c_uint]
    core.probe_memory.restype = c.c_void_p
    core.probe_memory_size.argtypes = [c.c_uint]
    core.probe_memory_size.restype = c.c_size_t
    rom_buffer = c.create_string_buffer(bytes(rom))
    assert core.probe_init(rom_buffer, len(rom)), "Core initialization failed"
    try:
        for _ in range(prewarm):
            core.probe_step(0, 0)
        seeds = []
        for slot, memory_id in enumerate((0,)):
            size = core.probe_memory_size(memory_id)
            pointer = core.probe_memory(memory_id)
            assert size == 2048 and pointer, "Battery RAM unavailable"
            seed = bytes((index + 49 + slot * 47) % 256 for index in range(256))
            c.memmove(pointer + 0x100, seed, len(seed))
            seeds.append(digest(seed))
        size = core.probe_size()
        buffer = c.create_string_buffer(size)

        def save():
            assert core.probe_save(buffer, size), "State serialization failed"
            return buffer.raw

        def load(data):
            assert core.probe_load(data, len(data)), "State restoration failed"

        initial = save()
        (output / "initial.bin").write_bytes(initial)
        hashes, checkpoints = [], []
        for frame in range(frames):
            core.probe_step(*inputs(frame))
            state = save()
            hashes.append(digest(state))
            if frame < 3:
                (output / f"native-frame-{frame}.bin").write_bytes(state)
            if frame % 97 == 0:
                checkpoints.append((frame, state))
        load(initial)
        roundtrip = save()
        (output / "native-roundtrip.bin").write_bytes(roundtrip)
        assert roundtrip == initial, "Native roundtrip differs"
        for frame in range(frames):
            core.probe_step(*inputs(frame))
            replayed = save()
            if digest(replayed) != hashes[frame]:
                (output / "native-mismatch.bin").write_bytes(replayed)
            assert digest(replayed) == hashes[frame], (
                f"Native replay differs at {frame}"
            )
        for frame, state in checkpoints:
            for prediction in range(12):
                core.probe_step(0xFF if prediction % 2 else 0, 0x100)
            load(state)
            for replay in range(frame + 1, min(frames, frame + 71)):
                core.probe_step(*inputs(replay))
                assert digest(save()) == hashes[replay], (
                    f"Checkpoint replay differs at {replay}"
                )
        load(initial)
        malformed = []
        for offset in (0, 1):
            data = bytearray(initial)
            data[offset] ^= 1
            malformed.append(bytes(data))
        for data in malformed:
            assert not core.probe_load(data, len(data)), "Malformed header accepted"
            assert save() == initial, "Rejected load mutated state"
        reference = {
            "players": 2,
            "frames": frames,
            "size": size,
            "hashes": hashes,
            "batteryHashes": seeds,
        }
        (output / "reference.json").write_text(json.dumps(reference) + "\n")
        for wasm_prewarm in (1, 97):
            subprocess.run(
                [
                    "node",
                    str(Path(__file__).with_suffix(".mjs")),
                    str(artifacts),
                    str(output),
                    str(wasm_prewarm),
                ],
                check=True,
            )
            load((output / f"wasm-final-{wasm_prewarm}.bin").read_bytes())
            assert digest(save()) == hashes[-1], "WASM to native roundtrip differs"
            for slot, memory_id in enumerate((0,)):
                pointer = core.probe_memory(memory_id)
                assert digest(c.string_at(pointer + 0x100, 256)) == seeds[slot], (
                    "Battery data changed"
                )
        report = {
            "fixture": rom_path.name,
            "stateProfile": "Snes9x",
            "players": 2,
            "nativePrewarm": prewarm,
            "size": size,
            "frames": frames,
            "nativeReplay": True,
            "nativeCheckpoints": len(checkpoints),
            "malformedRejected": len(malformed),
            "wasmPrewarm": [1, 97],
            "crossPlatformReplay": True,
            "sharedBatteryBytes": 2048,
            "batterySeedBytes": 256,
            "batteryPreserved": True,
            "audioWaveformReplayTested": False,
        }
        (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report))
    finally:
        core.probe_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifacts", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--frames", type=int, default=600)
    parser.add_argument("--rom", type=Path)
    parser.add_argument("--prewarm", type=int, nargs="+", default=[1, 180])
    args = parser.parse_args()
    assert args.frames >= 180, "Use at least 180 replay frames"
    fixtures = Path(__file__).resolve().parent / "fixtures"
    rom = args.rom or fixtures / "two-pad.sfc"
    for prewarm in args.prewarm:
        qualify(
            args.artifacts.resolve(),
            rom.resolve(),
            args.output.resolve() / f"warm{prewarm}",
            args.frames,
            prewarm,
        )


if __name__ == "__main__":
    main()
