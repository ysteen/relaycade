#!/usr/bin/env python3
"""Generate an original NTSC LoROM diagnostic for two joypads and battery SRAM."""

import argparse
import struct
from pathlib import Path


def build():
    code = bytearray()
    labels = {}
    branches = []

    def emit(*values):
        code.extend(values)

    def label(name):
        labels[name] = len(code)

    def branch(opcode, name):
        emit(opcode, 0)
        branches.append((len(code) - 1, name))

    def absolute(opcode, address):
        emit(opcode, address & 255, address >> 8)

    def sram(opcode, offset):
        emit(opcode, offset, 0, 0x70)

    # Native mode, 16-bit indexes, 8-bit accumulator, stack in low WRAM.
    emit(0x78, 0x18, 0xFB, 0xC2, 0x38, 0xA2, 0xFF, 0x1F, 0x9A)
    emit(0xA9, 0, 0, 0x5B, 0xE2, 0x20)
    for register in (0x4200, 0x420C, 0x2105, 0x212C, 0x212D, 0x2130, 0x2131):
        absolute(0x9C, register)
    emit(0xA9, 0x80)
    absolute(0x8D, 0x2100)
    emit(0xA9, 0)
    for offset in range(8):
        sram(0x8F, offset)
    emit(0xA9, 1)
    absolute(0x8D, 0x4200)
    emit(0xA9, 15)
    absolute(0x8D, 0x2100)

    label("frame")
    absolute(0xAD, 0x4212)
    emit(0x29, 0x80)
    branch(0xD0, "frame")
    label("vblank")
    absolute(0xAD, 0x4212)
    emit(0x29, 0x80)
    branch(0xF0, "vblank")
    label("joypad")
    absolute(0xAD, 0x4212)
    emit(0x29, 1)
    branch(0xD0, "joypad")

    # SRAM[0:4]: raw two-pad input; [4:6]: frame count; [6:8]: held counts.
    for offset in range(4):
        absolute(0xAD, 0x4218 + offset)
        sram(0x8F, offset)
    emit(0xC2, 0x20)
    sram(0xAF, 4)
    emit(0x1A)
    sram(0x8F, 4)
    emit(0xE2, 0x20)
    for player in range(2):
        absolute(0xAD, 0x4218 + player * 2)
        absolute(0x0D, 0x4219 + player * 2)
        branch(0xF0, f"released{player}")
        sram(0xAF, 6 + player)
        emit(0x1A)
        sram(0x8F, 6 + player)
        label(f"released{player}")

    # Backdrop red/blue responds independently to the two joypads.
    absolute(0x9C, 0x2121)
    absolute(0xAD, 0x4218)
    absolute(0x0D, 0x4219)
    emit(0x4A, 0x4A, 0x4A, 0x29, 31, 0x09, 3)
    absolute(0x8D, 0x2122)
    absolute(0xAD, 0x421A)
    absolute(0x0D, 0x421B)
    emit(0x4A, 0x4A, 0x4A, 0x29, 31, 0x0A, 0x0A)
    absolute(0x8D, 0x2122)
    absolute(0x4C, 0x8000 + labels["frame"])
    interrupt = 0x8000 + len(code)
    emit(0x40)
    for offset, name in branches:
        distance = labels[name] - (offset + 1)
        assert -128 <= distance <= 127
        code[offset] = distance & 255

    rom = bytearray([0xEA]) * (256 * 1024)
    rom[: len(code)] = code
    rom[0x7FC0:0x7FD5] = b"ROMM TWO PAD TEST".ljust(21, b" ")
    rom[0x7FD5:0x7FDC] = bytes((0x20, 2, 8, 1, 1, 0, 0))
    rom[0x7FDC:0x7FE0] = bytes(4)
    for vector in (
        0x7FE4,
        0x7FE6,
        0x7FE8,
        0x7FEA,
        0x7FEE,
        0x7FF4,
        0x7FF8,
        0x7FFA,
        0x7FFE,
    ):
        struct.pack_into("<H", rom, vector, interrupt)
    struct.pack_into("<H", rom, 0x7FFC, 0x8000)
    checksum = (sum(rom) + 510) & 0xFFFF
    struct.pack_into("<HH", rom, 0x7FDC, checksum ^ 0xFFFF, checksum)
    assert len(rom) == 256 * 1024 and sum(rom) & 0xFFFF == checksum
    return rom


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(build())
