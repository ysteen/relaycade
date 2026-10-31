#!/usr/bin/env python3
"""Qualify SameBoy SBR2 native/WASM state restoration with diagnostic ROMs."""

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


def qualify(artifacts, rom_path, output, frames):
    output.mkdir(parents=True, exist_ok=False)
    rom = bytearray(rom_path.read_bytes())
    rom[0x147], rom[0x149] = 3, 3  # MBC1 with 32 KiB battery RAM.
    rom[0x14D] = (-sum(rom[0x134:0x14D]) - 25) & 255
    (output / "fixture.gb").write_bytes(rom)
    core = c.CDLL(str(artifacts / "native-probe.so"))
    core.probe_init.argtypes = [c.c_void_p, c.c_size_t]
    core.probe_size.restype = c.c_size_t
    core.probe_save.argtypes = core.probe_load.argtypes = [c.c_void_p, c.c_size_t]
    core.retro_get_memory_data.restype = c.c_void_p
    core.retro_get_memory_size.restype = c.c_size_t
    rom_buffer = c.create_string_buffer(bytes(rom))
    assert core.probe_init(rom_buffer, len(rom)), "Core initialization failed"
    try:
        seeds = []
        for slot, memory_id in enumerate((0x100, 0x300)):
            size = core.retro_get_memory_size(memory_id)
            pointer = core.retro_get_memory_data(memory_id)
            assert size == 32768 and pointer, "Battery RAM unavailable"
            seed = bytes((index + 49 + slot * 47) % 256 for index in range(size))
            c.memmove(pointer, seed, size)
            seeds.append(digest(seed))
        for _ in range(180):
            core.probe_step(0, 0)
        size = core.probe_size()
        buffer = c.create_string_buffer(size)

        def save():
            assert core.probe_save(buffer, size), "State serialization failed"
            return buffer.raw

        def load(data):
            assert core.probe_load(data, len(data)), "State restoration failed"

        initial = save()
        assert initial[-48:-44] == b"SBR2", "Wrong core state profile"
        (output / "initial.bin").write_bytes(initial)
        hashes, checkpoints = [], []
        for frame in range(frames):
            core.probe_step(*inputs(frame))
            state = save()
            hashes.append(digest(state))
            if frame % 97 == 0:
                checkpoints.append((frame, state))
        load(initial)
        assert save() == initial, "Native roundtrip differs"
        for frame in range(frames):
            core.probe_step(*inputs(frame))
            assert digest(save()) == hashes[frame], f"Native replay differs at {frame}"
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
        malformed = [initial[:-1], initial[:-48]]
        for offset in (-48, -45, -44):
            data = bytearray(initial)
            data[offset] ^= 1
            malformed.append(bytes(data))
        for data in malformed:
            assert not core.probe_load(data, len(data)), "Malformed trailer accepted"
            assert save() == initial, "Rejected load mutated state"
        reference = {
            "frames": frames,
            "size": size,
            "hashes": hashes,
            "batteryHashes": seeds,
        }
        (output / "reference.json").write_text(json.dumps(reference) + "\n")
        for prewarm in (1, 97):
            subprocess.run(
                [
                    "node",
                    str(Path(__file__).with_suffix(".mjs")),
                    str(artifacts),
                    str(output),
                    str(prewarm),
                ],
                check=True,
            )
            load((output / f"wasm-final-{prewarm}.bin").read_bytes())
            assert digest(save()) == hashes[-1], "WASM to native roundtrip differs"
            for slot, memory_id in enumerate((0x100, 0x300)):
                pointer = core.retro_get_memory_data(memory_id)
                assert digest(c.string_at(pointer, 32768)) == seeds[slot], (
                    "Battery data changed"
                )
        report = {
            "fixture": rom_path.name,
            "stateProfile": "SBR2",
            "size": size,
            "frames": frames,
            "nativeReplay": True,
            "nativeCheckpoints": len(checkpoints),
            "malformedRejected": len(malformed),
            "wasmPrewarm": [1, 97],
            "crossPlatformReplay": True,
            "batteryBytesPerSlot": 32768,
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
    args = parser.parse_args()
    assert args.frames >= 180, "Use at least 180 replay frames"
    fixtures = Path(__file__).resolve().parent / "fixtures"
    roms = [args.rom] if args.rom else [fixtures / "link-1.gb", fixtures / "link-2.gbc"]
    for rom in roms:
        qualify(
            args.artifacts.resolve(),
            rom.resolve(),
            args.output.resolve() / rom.stem,
            args.frames,
        )


if __name__ == "__main__":
    main()
