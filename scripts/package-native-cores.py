#!/usr/bin/env python3
"""Validate native ABI artifacts and install matching downloads in a RomM checkout."""

import argparse
import hashlib
import json
import re
import shutil
import struct
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGETS = {
    "windows-x86_64": ("Windows x64 (64-bit)", 0x8664),
    "windows-x86": ("Windows x86 (32-bit)", 0x14C),
    "windows-arm64": ("Windows ARM64", 0xAA64),
    "android-arm64-v8a": ("Android ARM64 (arm64-v8a)", 183),
    "android-armeabi-v7a": ("Android ARM32 (armeabi-v7a)", 40),
    "android-x86_64": ("Android x86_64", 62),
    "android-x86": ("Android x86 (32-bit)", 3),
}
DIRECTORIES = {
    "sameboy": "sameboy-sbr2",
    "mgba_splitscreen": "mgba-spst4-multi",
    "snes9x": "snes9x-2d4cce69",
}
CORE_INFO = Path(__file__).resolve().parents[1] / "core-info"
EXPORTS = {
    "retro_" + name
    for name in [
        "init",
        "deinit",
        "api_version",
        "get_system_info",
        "get_system_av_info",
        "set_environment",
        "set_video_refresh",
        "set_audio_sample",
        "set_audio_sample_batch",
        "set_input_poll",
        "set_input_state",
        "set_controller_port_device",
        "reset",
        "run",
        "serialize_size",
        "serialize",
        "unserialize",
        "cheat_reset",
        "cheat_set",
        "load_game",
        "load_game_special",
        "unload_game",
        "get_region",
        "get_memory_data",
        "get_memory_size",
    ]
}


def inspect(binary, target, machine, llvm):
    data = binary.read_bytes()
    android = target.startswith("android-")
    if android:
        assert data[:4] == b"\x7fELF" and data[5] == 1, f"Invalid Android ELF: {binary}"
        assert struct.unpack_from("<H", data, 18)[0] == machine, f"Wrong ABI: {binary}"
        elf64 = data[4] == 2
        offset = struct.unpack_from("<Q" if elf64 else "<I", data, 32 if elf64 else 28)[
            0
        ]
        entry_size, count = struct.unpack_from("<HH", data, 54 if elf64 else 42)
        alignments = []
        for i in range(count):
            entry = offset + i * entry_size
            if struct.unpack_from("<I", data, entry)[0] == 1:
                alignments.append(
                    struct.unpack_from(
                        "<Q" if elf64 else "<I", data, entry + (48 if elf64 else 28)
                    )[0]
                )
        assert (
            alignments and min(alignments) >= 16384
        ), f"Missing 16 KiB alignment: {binary}"
        info = subprocess.check_output(
            [str(llvm), "--needed-libs", "--dyn-symbols", str(binary)], text=True
        )
        libraries = re.search(r"NeededLibraries \[([^]]*)\]", info).group(1).split()
        assert set(libraries) <= {
            "libc.so",
            "libm.so",
            "libdl.so",
            "liblog.so",
            "libz.so",
            "libandroid.so",
        }, libraries
    else:
        assert data[:2] == b"MZ", f"Invalid Windows DLL: {binary}"
        offset = struct.unpack_from("<I", data, 0x3C)[0]
        assert data[offset : offset + 4] == b"PE\0\0"
        assert (
            struct.unpack_from("<H", data, offset + 4)[0] == machine
        ), f"Wrong Windows ABI: {binary}"
        assert (
            struct.unpack_from("<H", data, offset + 22)[0] & 0x2000
        ), f"Not a DLL: {binary}"
        info = subprocess.check_output(
            [str(llvm), "--coff-exports", str(binary)], text=True
        )
        imports = subprocess.check_output(
            [str(llvm), "--coff-imports", str(binary)], text=True
        )
        libraries = re.findall(r"Name: ([^\s]+\.dll)", imports, re.IGNORECASE)
        allowed = {
            "kernel32.dll",
            "user32.dll",
            "advapi32.dll",
            "ws2_32.dll",
            "shlwapi.dll",
            "shell32.dll",
            "ole32.dll",
            "crypt32.dll",
            "msvcrt.dll",
            "ucrtbase.dll",
        }
        assert all(
            name.lower() in allowed or name.lower().startswith("api-ms-win-")
            for name in libraries
        ), libraries
    exported = set(re.findall(r"Name: (retro_\w+)(?:\s|$)", info))
    assert (
        EXPORTS <= exported
    ), f"Missing libretro exports in {binary}: {EXPORTS - exported}"
    return {
        "bytes": len(data),
        "exports": len(EXPORTS),
        "dependencies": libraries,
        "sha256": hashlib.sha256(data).hexdigest(),
        **({"pageAlignment": min(alignments)} if android else {}),
    }


def install_core_info(romm, catalog):
    for source in sorted(CORE_INFO.glob("*_libretro.info")):
        core = source.name.removesuffix("_libretro.info")
        folder = DIRECTORIES[core]
        version = catalog[core]["native"]["coreVersion"]
        assert f'display_version = "{version}"' in source.read_text(), source
        destination = romm / "custom-emulatorjs/data/cores/compat/rollback" / folder
        destination.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination / source.name)
        catalog[core]["native"]["coreInfo"] = {
            "path": f"../data/cores/compat/rollback/{folder}/{source.name}",
            "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("romm", type=Path)
    parser.add_argument(
        "--info-only",
        action="store_true",
        help="Install core info without copying binaries",
    )
    parser.add_argument(
        "--artifacts",
        type=Path,
        default=ROOT / "result/netplay-interop/cross-platform/artifacts",
    )
    parser.add_argument(
        "--llvm",
        type=Path,
        default=ROOT
        / ".cache/native-toolchains/llvm-mingw-20260826-ucrt-ubuntu-22.04-x86_64/bin/llvm-readobj",
    )
    parser.add_argument("--cores", nargs="+", choices=list(DIRECTORIES), default=list(DIRECTORIES))
    parser.add_argument("--targets", nargs="+", choices=list(TARGETS), default=list(TARGETS))
    args = parser.parse_args()
    catalog_path = args.romm / "custom-emulatorjs/input-netplay/bridge-cores.json"
    catalog = json.loads(catalog_path.read_text())
    if args.info_only:
        install_core_info(args.romm, catalog)
        catalog_path.write_text(json.dumps(catalog, indent=2) + "\n")
        print("Installed core info; native binaries unchanged")
        return
    audit = {}
    for core in args.cores:
        for target in args.targets:
            _, machine = TARGETS[target]
            source = args.artifacts / core / target
            manifest = json.loads((source / "manifest.json").read_text())
            assert manifest["target"] == target
            assert manifest["version"] == catalog[core]["native"]["coreVersion"]
            if core == "mgba_splitscreen":
                multi_rom_patch = CORE_INFO.parent / "patches/mgba-multi-rom.patch"
                assert manifest.get("orderedCartridges") is True
                assert manifest.get("multiRomPatchSha256") == hashlib.sha256(multi_rom_patch.read_bytes()).hexdigest()
                save_init_patch = CORE_INFO.parent / "patches/mgba-native-save-init.patch"
                assert manifest.get("saveMemoryInitialization") == "before-first-frame-v1"
                assert manifest.get("saveInitPatchSha256") == hashlib.sha256(save_init_patch.read_bytes()).hexdigest()
                if target.startswith("windows-"):
                    view_patch = CORE_INFO.parent / "patches/mgba-local-player-view.patch"
                    assert manifest.get("localPlayerView") == "netplay-mode-file-v1"
                    assert manifest.get("localPlayerViewPatchSha256") == hashlib.sha256(view_patch.read_bytes()).hexdigest()
                startup_patch = CORE_INFO.parent / "patches/mgba-native-startup.patch"
                assert (
                    manifest.get("startupPatchSha256")
                    == hashlib.sha256(startup_patch.read_bytes()).hexdigest()
                )
            filename = f"{core}_libretro." + (
                "so" if target.startswith("android-") else "dll"
            )
            result = inspect(source / filename, target, machine, args.llvm)
            assert result["sha256"] == manifest["sha256"][filename]
            audit[f"{core}/{target}"] = result
    for core in args.cores:
        folder = DIRECTORIES[core]
        destination = (
            args.romm / "custom-emulatorjs/data/cores/compat/rollback" / folder
        )
        if core == "mgba_splitscreen":
            shutil.copy2(
                CORE_INFO.parent / "patches/mgba-native-startup.patch", destination
            )
            shutil.copy2(
                CORE_INFO.parent / "patches/mgba-native-save-init.patch", destination
            )
            shutil.copy2(
                CORE_INFO.parent / "patches/mgba-local-player-view.patch", destination
            )
        downloads = {
            "linux-x86_64": {
                "label": "Linux x86_64",
                "path": catalog[core]["native"]["nativeDownload"],
                "sha256": hashlib.sha256(
                    (destination / f"{core}_libretro.so").read_bytes()
                ).hexdigest(),
            }
        }
        for target in args.targets:
            label, _ = TARGETS[target]
            source = args.artifacts / core / target
            shutil.copytree(source, destination / "native" / target, dirs_exist_ok=True)
            filename = f"{core}_libretro." + (
                "so" if target.startswith("android-") else "dll"
            )
            downloads[target] = {
                "label": label,
                "path": f"../data/cores/compat/rollback/{folder}/native/{target}/{filename}",
                "sha256": audit[f"{core}/{target}"]["sha256"],
            }
        catalog[core]["downloads"] = downloads
    install_core_info(args.romm, catalog)
    catalog_path.write_text(json.dumps(catalog, indent=2) + "\n")
    (args.artifacts.parent / "artifact-audit.json").write_text(
        json.dumps(audit, indent=2) + "\n"
    )
    print(f"Validated and installed {len(audit)} native builds")


if __name__ == "__main__":
    main()
