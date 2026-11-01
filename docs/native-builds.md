# Windows and Android core builds

The RomM adapter distributes the same pinned core versions as its WASM packages:
SameBoy SBR2, mGBA Splitscreen SPST4 and Snes9x 2d4cce69. No RetroArch application
patch is required. The browser suggests a download for the visitor's OS and CPU;
the installed RetroArch app can have a different architecture, so manual
selection remains available. Downloading a core does not occupy a room slot.

For mGBA Splitscreen, also download `mgba_splitscreen_libretro.info` and copy it
to **Settings → Directory → Core Info** in RetroArch. Keep its filename unchanged.
Close RetroArch, remove `core_info.cache` from that directory if present, and
reopen it to rebuild the extension list. Select the installed core under
**Load Core**, then open the ROM under **Load Content**. Installing a DLL alone
does not register this custom core's GBA extension in the shared content filter.

| Platform | Builds                              | Verification                                                                                                                                                     |
| -------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows  | x86_64, x86                         | All three DLLs load and report matching versions. mGBA/Snes9x restore and replay correctly, and match Linux state bytes after 120 frames from the same snapshot. |
| Windows  | ARM64                               | PE machine type, libretro exports and system-only dependencies verified. No ARM64 Windows runtime test.                                                          |
| Android  | arm64-v8a, armeabi-v7a, x86_64, x86 | ELF architecture, libretro exports, system-only dependencies and 16 KiB load-segment alignment verified. API 24 minimum. No device test.                         |
| Linux    | x86_64                              | Existing native/browser qualification applies.                                                                                                                   |

Windows tests use a minimal libretro frontend and original diagnostic cartridges.
They do not establish end-to-end Windows RetroArch netplay or compatibility with
every commercial game. SameBoy gameplay was not repeated in this pass.

## Toolchains

Build on Linux with Python 3.12+, CMake, make, patch, tar and the existing source
archives/boot ROMs described in the core build scripts. Compiler parallelism is
fixed at two. Download and unpack these tools inside the workspace cache:

- [LLVM-MinGW 20260826 UCRT, Ubuntu 22.04 x86_64](https://github.com/mstorsjo/llvm-mingw/releases/tag/20260826), archive SHA-256 `cee8d2ce3da5145ce4dc882e70d0b0719a783d53a99752c60948fc0659975a65`.
- [Android NDK r30](https://developer.android.com/ndk/downloads), Linux archive SHA-1 `5107f898313790e449e87eee2183d9a20602dee9`.
- [zlib 1.3.2](https://zlib.net/), tar.gz SHA-256 `bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16`. Windows Snes9x links it statically and includes its license.

```sh
python3 scripts/build-native-cores.py --help
python3 scripts/build-native-cores.py
python3 scripts/package-native-cores.py ../romm-netplay-publish
```

The packager also installs the metadata in `core-info/` and records its checksum
in the adapter catalog. Use `--info-only` to update this metadata without copying
or inspecting native binaries.

The default output is `../result/netplay-interop/cross-platform`. Pass `--work`,
`--mingw`, `--ndk`, `--archives`, `--bootroms`, `--snes-source` and `--zlib-archive`
for another workspace. `--targets` and `--cores` restrict a rebuild. All source
archive and SameBoy boot ROM hashes are checked. mGBA also applies
`patches/mgba-native-platforms.patch` to exclude its unused Windows directory
backend from the minimal libretro target; emulation and state formats are unchanged.

The packager checks all 21 new binaries before writing the adapter catalog.
Generated artifacts stay outside this repository; each installed binary has its
own source revision, compiler version and SHA-256 manifest. The existing Linux
and WASM packages retain their paths. Keep upstream licenses beside distributed
cores and the platform patch with the mGBA package.

`test/native-library-probe.c` builds a small dynamic core loader using the existing
probe implementations. `scripts/verify-windows-cores.ps1` runs its x64/x86 builds
in `%LOCALAPPDATA%\RomMNativeCoreTest`, saves logs in the workspace and exits every
process. Linux reference states and the probe executables are prepared separately.
