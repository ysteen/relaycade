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

The native mGBA package applies `patches/mgba-native-startup.patch`: one GBA
loaded through **Load Content** boots the **Players per ROM** setting directly
(default: two). Set three or four in **Quick Menu → Core Options**, then reload.
The GBA Link subsystems remain available for an explicit console count. The
native build does not wait for the in-core player-count menu, which can block
RetroArch's initial SRAM exchange when Netplay reloads content. The SPST4 format
and core compatibility version are unchanged; each manifest records the startup
patch checksum. These replacement binaries passed static ABI/export checks;
the updated Windows x64 helper and connection verification is described below.

Manual-start rooms send a neutral spectator frame with each heartbeat while a
native guest waits. RetroArch 1.22.2 disconnects after ten seconds without input
progress even when PING/PONG succeeds. Game start rebases that guest's wire
frames and restores the host state, so waiting frames do not become room input.
This avoids the persistent remote-pause issue in that frontend version.

Native clients that reconnect to a running room wait for the host's start
barrier while the remaining players continue. They receive lobby keepalives,
but no current-game CRC checkpoints until they are playing. Their waiting-frame
counter belongs to a different timeline; queuing active-game checkpoints there
would fill the verification window and incorrectly close the room. After the
host starts them, state transfer rebases the native frames and normal checksum
verification resumes. The 16-checkpoint backlog limit still applies to active
native players.

Pause/resume applies only to playing members after the game-start barrier.
Waiting native clients cannot pause the existing game, and preparation does
not relay pause commands to a browser without a session. The browser also
discards valid pause commands during preparation. Broker `game-starting`,
`game-started` and `game-pause-ignored` events identify these transitions.
Transport and mock-core tests cover reconnecting, pausing during preparation
and normal pause/resume after start; they do not qualify native gameplay.

During rollback play, the broker also uses RetroArch's standard `STALL` command
to keep an ahead native frontend near the active host. A lead above three
input frames requests a bounded wait toward a two-frame lead. Requests are
limited to 60 frames and separated by at least 120 host frames and two seconds,
including a settling period after startup or a host change. Only fresh progress
from the playing native or browser host drives this correction. Pauses, startup, restart,
lockstep guests and the native authority itself are excluded. Input
packets, their frame numbers, saved states and checksums are unchanged.

Broker logs record `native-paced` with `hostFrame`, `nativeFrame`, `leadFrames`
and `stallFrames`. These measure protocol frame alignment, not input-to-display
latency. The change has mock-clock convergence and TCP/WebSocket coverage;
the LAN tester reported that the persistent delay disappeared during actual
Windows/web play. Input-to-display timing and audio quality have not been
measured. No core or launcher download is required for this broker-only change.

The current `0.1.0-f1d5975-rollback2` build adds `mgba-multi-rom.patch`. It owns and loads every cartridge slot; all participants load the same ordered complete set and control their assigned console. The state layout remains SPST4, but the compatibility version changes so rollback1 cannot join accidentally. The matching web package and Windows x64/x86/ARM64 DLLs are built. Android remains excluded from this increment.

The Windows helper is [client/windows-session.ps1](../client/windows-session.ps1), distributed by the RomM adapter in a reusable launcher ZIP. Run **Register Launcher.cmd** once, then choose a player number, **Windows RetroArch** and **Join game** in each web room. Registration is per-user under `HKCU\Software\Classes\romm-netplay`; the helper is retained under `%LOCALAPPDATA%\RomMNetplay\Launcher`. Only origins explicitly registered from a downloaded package may launch a room. Downloading the ZIP does not reserve or switch a player. A short-lived launch request is claimed when the helper opens, retaining the existing member and seat. It validates hashes and the installed RetroArch ABI, uses isolated configuration/save paths and binds one loopback TCP connection to the room's private credential. Stock RetroArch 1.22.2 requests client passwords interactively; its `netplay_password` config is for hosting. The helper answers that exchange and relays the original protocol without changing the RetroArch executable. A browser-to-Windows handoff preserves the member and seat, with RetroArch taking host priority.

The helper searches the remembered path, PATH, registered installations and common Windows folders before downloading anything. `-RetroArch` selects an explicit executable. If no matching application is found, Windows x64/x86 use the official portable RetroArch 1.22.2 archive, pinned by SHA-256 and extracted by Windows `tar.exe`. Runtime downloads never include the RomM credential. The extracted application is cached under `%LOCALAPPDATA%\RomMNetplay\runtimes`; no installer or administrator rights are needed. Native ARM64 requires an existing executable, or a new x64 room package to use Windows x64 emulation. The helper does not modify an existing installation.

Each Windows computer must trust the RomM server's HTTPS certificate. For a private CA, the RomM adapter can include `RomM-CA.cer` and **Install Certificate.cmd** in the launcher ZIP. Run the installer once on the computer running RetroArch; it verifies the bundled hash and adds the public root to **Current User > Trusted Root Certification Authorities**, skipping an already trusted root. Normal playback does not install certificates. Publicly trusted HTTPS needs no additional installation. A browser certificate exception does not grant trust to PowerShell. The launcher does not require administrator rights or bypass certificate validation. Download errors show the endpoint and underlying TLS, DNS, proxy, connection or timeout error, with launch credentials and URL secrets removed.

The Windows mGBA builds also apply `mgba-local-player-view.patch`. The helper observes the standard MODE packet's own-client flag and device bitmask, writes the assigned console to a per-session file, and passes its path through the child process's `ROMM_NETPLAY_PLAYER_FILE` environment variable. The core uses its existing focus layout and matching audio source, polling the tiny file every 15 frames. Before an assignment it presents silence and a blank screen. This display preference is excluded from SPST4 state and does not change the compatibility version. Ordinary manual launches without that variable retain their layout options. The broker protocol and stock RetroArch executable are unchanged.

Display verification compared P1/P2 output with the corresponding composite pixels, checked an unassigned blank screen and identical emulation states after 120 frames across all views. MODE parsing covers P1-P4 and preserves relayed state bytes. These bounded Windows checks do not repeat native rejoin qualification.

Windows x64 verification on 2026-11-02 used distinct diagnostic cartridges, 120-frame restore/replay equality and a real RetroArch 1.22.2 plus WASM-host run: 300 confirmed frames, five state checks, preserved guest SRAM, 294 link receipts, over ten seconds waiting in the lobby and two total members. Windows x86/ARM64 builds passed ABI/export/hash inspection; their runtime was not repeated. These results do not establish commercial-game trading, native rejoin or audio quality.

`test/windows-launch-smoke.mjs` refuses execution outside Windows. Compile `test/windows-bounded.c` with the cached MinGW toolchain and invoke Windows Node through that wrapper, which limits the whole job to 1.5 GiB, two CPUs and 60 seconds. Supply the directory containing `web-build/core-probe.mjs`, matched native artifacts, the two diagnostic fixtures and a portable RetroArch 1.22.2 install. It exercises the real helper, scoped ROM downloads, raw/ZIP content, identity handoff, native authentication, lobby wait, start and state verification. Do not run native qualification or rejoin tests in the affected WSL workspace.

[gpSP uses Libretro's Netpacket interface](https://www.davidgf.net/2024/01/13/gba-wireless-adapter/)
to exchange emulated link data while each device runs its own game and save.
Compatible different Pokemon editions can communicate this way. Current
[upstream code](https://github.com/libretro/gpsp/blob/master/libretro/libretro_core_options.h)
includes Wireless Adapter and Pokemon Gen3 serial modes. That packet transport
is not implemented in this rollback bridge; removing its ROM CRC check would
not add it.

| Platform | Builds                              | Verification                                                                                                                                                     |
| -------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows  | x86_64, x86                         | All three DLLs load and report matching versions. mGBA/Snes9x restore and replay correctly, and match Linux state bytes after 120 frames from the same snapshot. |
| Windows  | ARM64                               | PE machine type, libretro exports and system-only dependencies verified. No ARM64 Windows runtime test.                                                          |
| Android  | arm64-v8a, armeabi-v7a, x86_64, x86 | ELF architecture, libretro exports, system-only dependencies and 16 KiB load-segment alignment verified. API 24 minimum. No device test.                         |
| Linux    | x86_64                              | Existing native/browser qualification applies.                                                                                                                   |

Windows tests use a minimal libretro frontend and original diagnostic cartridges.
The newer Windows x64 mGBA helper check above additionally covers RetroArch netplay. Neither set establishes compatibility with every commercial game. SameBoy gameplay was not repeated in this pass.

## Toolchains

Build on Linux with Python 3.12+, CMake, make, patch, tar and the existing source
archives/boot ROMs described in the core build scripts. Compiler parallelism is
limited to two (`--jobs 1` also limits linker threads to one). Download and unpack these tools inside the workspace cache:

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

The helper sets `pause_nonactive = "false"` for room play. Session settings precede the inherited configuration because RetroArch uses the first occurrence of a duplicate key. The installation configuration and unrelated control settings are preserved. Existing registered helpers need a fresh launcher download and **Register Launcher.cmd** to use this change. `test/windows-session-config.ps1` verifies precedence and isolation with synthetic cached files without running an emulator.

### Native-first rooms

Account-bound rollback rooms opt into `nativeAuthority`. The relay selects RetroArch before web, obtains its initial snapshot with the stock REQUEST_STATE command, and forwards input/state traffic. This does not make RetroArch listen on a public port. Native-only rooms need no web emulator; the authenticated browser room remains the control surface. Active participants take precedence over waiting rejoins. On departure, another active RetroArch takes over, then an active web player. Browser peers use bounded, muted catch-up steps against native frame progress; other native peers use STALL pacing. Native-only verification requests one bounded state snapshot every 600 frames.

Launcher manifest v3 stages all selected cartridge saves in `saves/.netplay`, the directory stock RetroArch uses for rollback clients. Its configured save directory stays at `saves`, so RetroArch appends the child directory only once. Version 3 rejects older helpers that would seed the wrong directory. Update the reusable launcher registration once and create a fresh room. A playing web peer remains the source of per-account progress uploads; native-only automatic uploads are not implemented. New transport/client tests use simulated cores and protocol peers, not native emulator qualification.

`mgba-native-save-init.patch` initializes deferred cartridge memory when the frontend first queries it, before the first frame. RetroArch restores SRAM at that point; returning null until `retro_run` would discard every selected save. The patch changes neither SPST4 nor the compatibility version, and applies to native builds only. `test/windows-save-startup.ps1` runs the core API probe in a bounded Windows job without executing game frames. It checks independent P1-P4 saves, fresh loads, and preservation in the initial snapshot; it does not qualify gameplay or rejoin.
