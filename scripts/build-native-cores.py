#!/usr/bin/env python3
"""Build the pinned rollback cores for Windows and Android with two workers."""

import argparse
import hashlib
import json
import shutil
import subprocess
import tarfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ROOT = REPO.parent
ANDROID_API = 24
TARGETS = {
    "windows-x86_64": ("x86_64", None),
    "windows-x86": ("i686", None),
    "windows-arm64": ("aarch64", None),
    "android-arm64-v8a": ("aarch64-linux-android", "arm64-v8a"),
    "android-armeabi-v7a": ("armv7a-linux-androideabi", "armeabi-v7a"),
    "android-x86_64": ("x86_64-linux-android", "x86_64"),
    "android-x86": ("i686-linux-android", "x86"),
}
CORES = {
    "sameboy": {
        "name": "SameBoy",
        "version": "1.0.4c87d256-rollback2",
        "revision": "c87d256",
        "profile": "SBR2",
        "archive": "SameBoy-c87d256.tar.gz",
        "sha256": "67a65d1f13e8a132bff3955bdf98ad67c5049552721f9417c9f597ae0039b6a6",
        "patch": "sameboy-rollback-state.patch",
    },
    "mgba_splitscreen": {
        "name": "mGBA Splitscreen",
        "version": "0.1.0-f1d5975-rollback1",
        "revision": "f1d5975d77285f77affbfe64b7050ebd5c4b6a77",
        "profile": "SPST4",
        "archive": "mgba-splitscreen-f1d5975.tar.gz",
        "sha256": "8374542f8a042a1ad661a5e886083f3cfcf84fe79c1e471dae5eb6c432b88958",
        "patch": "mgba-rollback-state.patch",
    },
    "snes9x": {
        "name": "Snes9x",
        "version": "1.632d4cce69",
        "revision": "2d4cce69f4fe1c53a2c1423cdc06f2dea8b870a1",
    },
}
BOOT_HASHES = {
    "agb": "648fd2ade35a77ce93fb4ceac754b0f0465f1eaf0db0cbef1bed55bfd8a71794",
    "cgb0": "2c297b6cb762cd0a50253449fd026ae30c76f0cc30b919e2ff498bca7682eacc",
    "cgb": "f767b8e7e510a255f81328c89dba6e0c996b370e1bc86aebb8584a7da47a5bba",
    "dmg": "6f64da4cecd7e54e2f928eb3e3ba7810a7a567d0d247cc71737d1771e073a916",
    "mgb": "12eb4b96f8c2c19cd51c209af1f0a5aa19e01f886114ae848258a592f408ef4e",
    "sgb2": "8a65465a9da7ec657726a671da9a85963cf19d2c975e499aea6b97eb37e0b6ea",
    "sgb": "b60d493a7944ccf74c81f1e7b6bf38c2c7029e296648ea0e74cb22b10dd1fcb8",
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(command, log, cwd=None):
    log.write("\n" + " ".join(map(str, command)) + "\n")
    log.flush()
    subprocess.run(
        list(map(str, command)),
        cwd=cwd,
        stdout=log,
        stderr=subprocess.STDOUT,
        check=True,
    )


def prepare(core, config, source, args, log):
    source.mkdir(parents=True)
    if core == "snes9x":
        archive = source.parent / "snes9x.tar"
        with archive.open("wb") as stream:
            subprocess.run(
                ["git", "-C", str(args.snes_source), "archive", config["revision"]],
                stdout=stream,
                check=True,
            )
        with tarfile.open(archive) as package:
            package.extractall(source, filter="data")
    else:
        archive = args.archives / config["archive"]
        if digest(archive) != config["sha256"]:
            raise ValueError(f"Source checksum mismatch: {archive}")
        run(["tar", "-xf", archive, "--strip-components=1", "-C", source], log)
        run(
            [
                "patch",
                "-d",
                source,
                "-p1",
                "--input",
                REPO / "patches" / config["patch"],
            ],
            log,
        )


def windows_flags(tool, arch):
    prefix = tool / "bin" / f"{arch}-w64-mingw32"
    return [
        "-DCMAKE_SYSTEM_NAME=Windows",
        f"-DCMAKE_C_COMPILER={prefix}-clang",
        f"-DCMAKE_CXX_COMPILER={prefix}-clang++",
        f"-DCMAKE_RC_COMPILER={prefix}-windres",
        f"-DCMAKE_FIND_ROOT_PATH={tool}/{arch}-w64-mingw32",
        "-DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=ONLY",
        "-DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=ONLY",
        "-DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=ONLY",
        "-DCMAKE_FIND_ROOT_PATH_MODE_PROGRAM=NEVER",
    ]


def build_zlib(work, args, tool, arch, log):
    archive = args.zlib_archive
    if (
        digest(archive)
        != "bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16"
    ):
        raise ValueError("zlib source checksum mismatch")
    source = work / "zlib-source"
    if not source.exists():
        source.mkdir()
        run(["tar", "-xf", archive, "--strip-components=1", "-C", source], log)
    build_dir = work / "zlib-build"
    run(
        [
            "cmake",
            "-S",
            source,
            "-B",
            build_dir,
            *windows_flags(tool, arch),
            "-DCMAKE_BUILD_TYPE=Release",
            "-DZLIB_BUILD_SHARED=OFF",
            "-DZLIB_BUILD_STATIC=ON",
            "-DZLIB_BUILD_TESTING=OFF",
        ],
        log,
    )
    run(
        ["cmake", "--build", build_dir, "--target", "zlibstatic", f"-j{args.jobs}"], log
    )
    return source, build_dir


def build(core, target, args):
    config = CORES[core]
    arch, abi = TARGETS[target]
    android = abi is not None
    tool = args.ndk / "toolchains/llvm/prebuilt/linux-x86_64" if android else args.mingw
    prefix = f"{arch}{ANDROID_API}-" if android else f"{arch}-w64-mingw32-"
    cc = tool / "bin" / f"{prefix}clang"
    cxx = tool / "bin" / f"{prefix}clang++"
    if not cc.is_file():
        raise ValueError(f"Missing compiler: {cc}")
    work = args.work / target / core
    source = work / "source"
    dest = args.work / "artifacts" / core / target
    work.mkdir(parents=True, exist_ok=True)
    dest.mkdir(parents=True, exist_ok=True)
    extension = "so" if android else "dll"
    filename = f"{core}_libretro.{extension}"
    link = (
        "-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384"
        if android
        else "-static"
    )
    link += f" -Wl,--threads={args.jobs}"
    with (work / "build.log").open("a") as log:
        if not source.exists():
            prepare(core, config, source, args, log)
        if core == "mgba_splitscreen":
            startup_patch = REPO / "patches/mgba-native-startup.patch"
            wrapper = source / "src/platform/libretro-splitscreen/libretro.c"
            if "pendingPlayers = playersOpt;" not in wrapper.read_text():
                run(["patch", "-d", source, "-p1", "--input", startup_patch], log)
            platform_patch = REPO / "patches/mgba-native-platforms.patch"
            if "set(SP_CORE_SRC" not in (source / "CMakeLists.txt").read_text():
                run(["patch", "-d", source, "-p1", "--input", platform_patch], log)
            flags = [
                "-DCMAKE_BUILD_TYPE=Release",
                "-DLIBMGBA_ONLY=ON",
                "-DBUILD_LIBRETRO_SPLITSCREEN=ON",
                "-DBUILD_SHARED=OFF",
                "-DBUILD_STATIC=OFF",
                "-DENABLE_DEBUGGERS=OFF",
                "-DENABLE_SCRIPTING=OFF",
            ]
            flags += [
                f"-DUSE_{feature}=OFF"
                for feature in [
                    "ELF",
                    "LIBZIP",
                    "LZMA",
                    "MINIZIP",
                    "PNG",
                    "SQLITE3",
                    "ZLIB",
                ]
            ]
            if android:
                flags += [
                    f"-DCMAKE_TOOLCHAIN_FILE={args.ndk}/build/cmake/android.toolchain.cmake",
                    f"-DANDROID_ABI={abi}",
                    f"-DANDROID_PLATFORM=android-{ANDROID_API}",
                    "-DANDROID_STL=c++_static",
                ]
            else:
                flags += windows_flags(tool, arch)
            run(
                [
                    "cmake",
                    "-S",
                    source,
                    "-B",
                    work / "build",
                    *flags,
                    f"-DCMAKE_SHARED_LINKER_FLAGS={link}",
                ],
                log,
            )
            run(
                [
                    "cmake",
                    "--build",
                    work / "build",
                    "--target",
                    "mgba_splitscreen_libretro",
                    f"-j{args.jobs}",
                ],
                log,
            )
            binary = work / "build" / filename
        else:
            flags = [
                f"CC={cc}",
                f"CXX={cxx}",
                f"AR={tool}/bin/llvm-ar",
                "platform=unix" if android else "platform=win",
                "LTO=",
            ]
            if core == "sameboy":
                flags += [
                    "GIT_VERSION=c87d256-rollback2",
                    f"BOOTROMS_DIR={args.bootroms}",
                ]
                binary = source / filename
            else:
                flags += ["GIT_VERSION=2d4cce69", "HAVE_STRINGS_H=1"]
                binary = source / "libretro" / filename
            if android:
                runtime = " -static-libstdc++" if core == "snes9x" else ""
                flags += [
                    f"LDFLAGS={link} -lm{runtime}",
                    "LIBS=-lz -lm" if core == "snes9x" else "LIBS=-lm",
                ]
            else:
                flags += [f"SHARED=-shared {link} -Wl,--no-undefined", "LIBS=-lcrypt32"]
                if core == "snes9x":
                    zlib_source, zlib_build = build_zlib(work, args, tool, arch, log)
                    flags += [
                        f"CPPFLAGS=-I{zlib_source} -I{zlib_build}",
                        f"LIBS={zlib_build}/libzs.a -lcrypt32",
                    ]
            run(["make", "-C", source / "libretro", *flags, "clean"], log)
            run(["make", "-C", source / "libretro", f"-j{args.jobs}", *flags], log)
        shutil.copy2(binary, dest / filename)
        run([tool / "bin/llvm-strip", "--strip-unneeded", dest / filename], log)
        run(
            [
                tool / "bin/llvm-readobj",
                "--file-headers",
                "--needed-libs",
                "--coff-imports" if not android else "--program-headers",
                dest / filename,
            ],
            log,
        )
    version = subprocess.check_output([str(cc), "--version"], text=True).splitlines()[0]
    manifest = {
        "core": config["name"],
        "version": config["version"],
        "sourceRevision": config["revision"],
        "target": target,
        "compiler": version,
        "sha256": {filename: digest(dest / filename)},
    }
    if android:
        manifest.update(androidApi=ANDROID_API, androidAbi=abi, pageAlignment=16384)
    elif core == "snes9x":
        manifest["zlib"] = "1.3.2 (static)"
        shutil.copy2(work / "zlib-source/LICENSE", dest / "zlib-LICENSE.txt")
    if "patch" in config:
        manifest.update(
            stateProfile=config["profile"],
            patchSha256=digest(REPO / "patches" / config["patch"]),
        )
    if core == "mgba_splitscreen":
        manifest["startupPatchSha256"] = digest(
            REPO / "patches/mgba-native-startup.patch"
        )
        manifest["nativeStartup"] = "configured-players-v1"
        manifest["platformPatchSha256"] = digest(
            REPO / "patches/mgba-native-platforms.patch"
        )
    (dest / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Built {core}: {target}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=int, choices=[1, 2], default=2)
    parser.add_argument("--targets", nargs="+", choices=TARGETS, default=list(TARGETS))
    parser.add_argument("--cores", nargs="+", choices=CORES, default=list(CORES))
    parser.add_argument(
        "--work", type=Path, default=ROOT / "result/netplay-interop/cross-platform"
    )
    parser.add_argument(
        "--mingw",
        type=Path,
        default=ROOT
        / ".cache/native-toolchains/llvm-mingw-20260826-ucrt-ubuntu-22.04-x86_64",
    )
    parser.add_argument(
        "--ndk", type=Path, default=ROOT / ".cache/native-toolchains/android-ndk-r30"
    )
    parser.add_argument(
        "--archives",
        type=Path,
        default=ROOT / "result/netplay-interop/stock-core/downloads",
    )
    parser.add_argument(
        "--bootroms",
        type=Path,
        default=ROOT
        / "result/netplay-interop/stock-core/SameBoy-c87d256/build/bin/BootROMs",
    )
    parser.add_argument(
        "--snes-source", type=Path, default=ROOT / "build/compile/snes9x"
    )
    parser.add_argument(
        "--zlib-archive",
        type=Path,
        default=ROOT / ".cache/native-toolchains/downloads/zlib-1.3.2.tar.gz",
    )
    args = parser.parse_args()
    if "sameboy" in args.cores:
        for model, expected in BOOT_HASHES.items():
            if digest(args.bootroms / f"{model}_boot.bin") != expected:
                raise ValueError(f"Boot ROM mismatch: {model}")
    for target in args.targets:
        for core in args.cores:
            build(core, target, args)


if __name__ == "__main__":
    main()
