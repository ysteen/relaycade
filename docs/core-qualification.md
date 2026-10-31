# Core qualification artifacts

This catalog covers the first implementation gate: matching local emulation with delayed input correction in SameBoy, mGBA Splitscreen, and Snes9x. The fixtures are original diagnostic cartridges. The native tests use an unmodified Linux RetroArch application; SameBoy and mGBA require the matching custom core. Generated packages are installed separately into versioned RomM compatibility asset directories.

## Source and state profiles

| Core             | Pinned source                              | Native library version    | State profile / bytes                                         |
| ---------------- | ------------------------------------------ | ------------------------- | ------------------------------------------------------------- |
| SameBoy          | `c87d256`                                  | `1.0.4c87d256-rollback2`  | SBR2 / 252714 for two linked GB or GBC consoles               |
| mGBA Splitscreen | `f1d5975d77285f77affbfe64b7050ebd5c4b6a77` | `0.1.0-f1d5975-rollback1` | SPST4 / 1450144, 2175204, 2900264 for 2, 3, 4 linked consoles |
| Snes9x           | `2d4cce69f4fe1c53a2c1423cdc06f2dea8b870a1` | `1.632d4cce69`            | Upstream state / 823407 for the two-pad LoROM fixture         |

State sizes are measured for these fixtures. Core identity, options, cartridge, player count, and state format must match before a session begins.

SameBoy's patch restores APU scheduling counters, cached key history, and joypad stability flags that its original states omit. The earlier SBR1 experiment restored scheduling but failed after incorrect input predictions; it must not be used. SBR2 passes that case. SBR2 runtime states are incompatible with the original core and SBR1; battery save formats remain unchanged.

mGBA's patch restores omitted runtime and battery data, restores all console hardware before the shared link driver, terminates restored event queues correctly, preserves the serial-send latch, and restores audio phase after register writes. It fixes unscheduled-event deadlines and uses emulated RTC time. The native and WASM builds use the same patch. SPST4 is distinct from the older web-only version 3. The original subsystem's identical-cartridge restriction remains.

Snes9x passed these state tests without a core source patch. It uses one console and two joypads, with a shared battery save.

## Rebuild

The browser build uses the EmulatorJS RetroArch frontend at
`becfa4bad25132b6cb8068a0da463f67eefee44e` plus the synchronous stepping shim
included in `frontend/ejs-input-netplay.inc`. Given a checkout containing that
commit (the original source is `https://github.com/ysteen/RetroArch.git`), prepare
it without depending on a modified RomM working tree:

```sh
bash scripts/prepare-web-frontend.sh /path/to/RetroArch /path/to/prepared-frontend
export COMPAT_FRONTEND=/path/to/prepared-frontend
```

The script archives the pinned commit, excludes local changes, installs the shim,
and refuses to overwrite an existing directory. `COMPAT_EMSDK` selects the
Emscripten SDK. Core archive and boot ROM inputs are checked against hashes in
their build scripts. Native and browser outputs must be built from the same
profile before distributing them.

Run commands from the repository root. These scripts use the prepared local Emscripten and RetroArch frontend workspaces, and refuse to reuse an existing output directory. Both `make` and Emscripten/Binaryen workers are bounded to two. Close the isolated debug browser before building.

```sh
COMPAT_WORK="$PWD/../result/netplay-interop/sameboy-qualification-build" COMPAT_BUILD_WEB=1 bash scripts/build-retroarch-compat-sameboy.sh
COMPAT_WORK="$PWD/../result/netplay-interop/mgba-qualification-build" COMPAT_BUILD_WEB=1 bash scripts/build-retroarch-rollback-mgba.sh
COMPAT_WORK="$PWD/../result/netplay-interop/snes-qualification-build" COMPAT_BUILD_WEB=1 bash scripts/build-retroarch-rollback-snes9x.sh
```

SameBoy and mGBA scripts verify the pinned source archive checksum. SameBoy also verifies the prepared open-source boot ROM binaries. Snes9x archives its exact Git commit into an isolated source tree, excluding local working-tree and unrelated GUI submodule changes. Each output contains `manifest.json` with source/profile identity and artifact hashes. The browser package additionally includes build metadata and the core license. No script replaces an installed core or production web package.

## State qualification

```sh
python3 test/sameboy-state-replay.py ../result/netplay-interop/sameboy-qualification-build --output ../result/netplay-interop/sameboy-qualification-result
python3 test/mgba-state-replay.py ../result/netplay-interop/mgba-qualification-build --output ../result/netplay-interop/mgba-qualification-result
python3 test/make-snes-fixture.py ../result/netplay-interop/snes-rollback/two-pad.sfc
python3 test/snes-state-replay.py ../result/netplay-interop/snes-qualification-build --output ../result/netplay-interop/snes-qualification-result
```

The paired Python/Node probes compare complete serialized states across native and WASM execution. Each scenario runs 600 varying-input frames and restores seven checkpoints after twelve deliberately wrong predicted frames, then replays the known inputs. Native initial states are imported into WASM instances with different prior histories (one and 97 warmup frames), and final WASM states are imported back into native cores. Invalid headers are rejected without changing the current state; SameBoy and mGBA also exercise invalid sizes and profile/player data.

SameBoy covers both GB and GBC fixtures with distinct 32 KiB SRAM seeds per console. mGBA covers 2, 3, and 4 players at native warmups of one and 180 frames, preserving a distinct 256-byte seed in each 128 KiB battery buffer. Snes9x covers warmups of one and 180 frames with a 256-byte seed in the shared 2 KiB battery. Seeds for GBA/SNES avoid the fixture's telemetry area.

The real-WASM rollback tests in `test/web-rollback-smoke.mjs` add two independently running peers and a third reference instance. They compare every confirmed state, test input influence, preserve battery data, and exercise prediction-window backpressure. The native smoke harnesses additionally exercise the TCP bridge and actual RetroArch input. See the parent README for those harness options.

## Actual browser gate

```sh
NETPLAY_TEST_PATCHED_ARTIFACTS="$PWD/../result/netplay-interop/sameboy-qualification-build" node test/browser-rollback-smoke.mjs
NETPLAY_TEST_CORE=mgba_splitscreen NETPLAY_TEST_PATCHED_ARTIFACTS="$PWD/../result/netplay-interop/mgba-qualification-build" node test/browser-rollback-smoke.mjs
NETPLAY_TEST_CORE=snes9x NETPLAY_TEST_PATCHED_ARTIFACTS="$PWD/../result/netplay-interop/snes-qualification-build" node test/browser-rollback-smoke.mjs
```

This harness boots two real Chrome pages using the complete EmulatorJS/RetroArch WASM frontend and the isolated core package. It drives delayed input packets through `BridgeSession` and compares all 1200 confirmed states against a third WASM reference across 600 frames per page. Transport is a deterministic delay harness; it does not exercise room authentication or the WebSocket gateway. It records canvas screenshots, Web Audio state, rollback statistics, and page exceptions. The helper always closes its isolated browser in `finally`.

All three cores passed with 53/71 rollbacks and 210/284 replayed frames, zero stalls, and zero page exceptions. Both pages rendered locally and had running AudioContexts with scheduled audio buffers. Snes9x also explicitly changes its rendered center RGB from `[25, 0, 0]` to `[156, 0, 0]` for player one and `[25, 0, 132]` for player two.

## Recorded local evidence

Paths below are relative to `../result/netplay-interop/` and are generated artifacts, not repository source files.

| Core    | Matching native/WASM/full browser build | State reports                                                     | Actual browser report                  |
| ------- | --------------------------------------- | ----------------------------------------------------------------- | -------------------------------------- |
| SameBoy | `sameboy-rollback/sbr2-web/`            | `sameboy-rollback/sbr2-qualification/{link-1,link-2}/result.json` | `sameboy-rollback/browser/result.json` |
| mGBA    | `mgba-rollback/v4-web/`                 | `mgba-rollback/qualification/{2,3,4}p-warm{1,180}/result.json`    | `mgba-rollback/browser/result.json`    |
| Snes9x  | `snes-rollback/stock-web/`              | `snes-rollback/qualification/warm{1,180}/result.json`             | `snes-rollback/browser/result.json`    |

The attempted 30-minute SameBoy GBC native soak did **not** pass. It stopped at 15 minutes 39 seconds after 58,251 executed web frames, 970 CRC checks, and 646 rollbacks. SRAM remained intact and no CRC mismatch was reported; the progress guard reported that native emulation had stopped advancing for five seconds. The cause is unresolved. Evidence: `sameboy-rollback/sbr2/native-gbc-30min/result.json`. This result must not be described as a successful 30-minute soak.

A separate instrumented retry exposed a watchdog false positive: a 6445 ms Node event-loop gap exceeded the five-second progress threshold while RetroArch was still alive and its socket remained open. The harness now requires a fresh progress observation after such a gap. This finding does not establish the cause of the first interrupted soak, which lacked that diagnostic data.

The corrected-watchdog SameBoy GBC retry passed for **100.092 seconds**: 6213 executed web frames, 6267 native frames, 103 delivered CRC checks, 68 rollbacks, 204 replayed frames, and 1020 received pressed-input packets from native RetroArch. The seeded SRAM survived; no recovery request, socket error, or long event-loop gap occurred (maximum poll gap 107 ms). Evidence: `sameboy-rollback/sbr2/native-gbc-6000-watchdog-fixed/result.json`. This is a focused 100-second pass, not a replacement 30-minute soak. An exact-profile negative control accepted the first CRC and then failed the session on the intentionally corrupted CRC at frame 120: `sameboy-rollback/sbr2/native-gbc-crc-negative-control-retry/result.json`.

The mGBA SPST4 live native run passed 667 executed web / 724 native frames, 11 delivered CRC checks, six rollbacks and 18 replayed frames. All three requested native button presses reached the cartridge, the battery seed survived, and no recovery request or error occurred. Evidence: `mgba-rollback/v4/native-delayed-smoke/result.json`. Its intentional CRC corruption at frame 120 stopped the session with an explicit compatibility error: `mgba-rollback/v4/native-crc-negative-control/result.json`.

The stock Snes9x live native run passed 662 executed web / 719 native frames, ten delivered CRC checks, six rollbacks and 18 replayed frames. Both joypads were observed in cartridge SRAM; the run received 92 native pressed-input packets and preserved the shared battery seed, with no recovery request or error. Evidence: `snes-rollback/stock/native-delayed-smoke/result.json`. Its negative control intentionally corrupted CRC frame 120; RetroArch requested state and the session stopped with an explicit compatibility mismatch rather than accepting divergent emulation: `snes-rollback/stock/native-crc-negative-control/result.json`.

## Standalone extraction and RomM adapter verification

The independent repository passed all 49 transport/client tests and its first
GitHub Actions run, including Docker build and startup:
[run 41223256063](https://github.com/ysteen/retroarch-netplay-bridge/actions/runs/41223256063).
The RomM SNES API passed 51 targeted account/permission tests. The installed
browser room UI passed SameBoy, mGBA, and Snes9x at 603 confirmed frames per peer
over real WebSockets, including delayed inputs, account save uploads, keyboard,
gamepad, touch, both themes, and widths from 320 to 3840 pixels. The RomM API was
mocked in this browser harness; its actual permission checks have separate tests.

Independent-project native extension results:

| Core             | Web / native frames | Delivered CRCs | Rollbacks | SRAM      |
| ---------------- | ------------------- | -------------- | --------- | --------- |
| mGBA Splitscreen | 6005 / 6063         | 100            | 66        | Preserved |
| Snes9x           | 6005 / 6062         | 100            | 66        | Preserved |

The second SameBoy soak also did **not** complete a clean 30-minute run. It
executed 85,837 web frames with 1,430 delivered CRCs and 952 rollbacks before a
388,044 ms harness scheduling gap and an `EPIPE`/native connection failure.
Advancing emulation was observed for about 23 minutes; the 29m49s wall-clock
duration includes the gap. SRAM remained intact and no CRC mismatch/state request
was observed. The user requested no further SameBoy testing, and it was not
restarted. The raw failed `native-gbc-30min-watchdog-fixed/result.json` is preserved
with a separate `stop-note.json`; this is not recorded as a successful soak.

The RomM SNES adapter currently accepts standard non-interleaved NTSC LoROM/HiROM
up to 4 MiB with an unambiguous valid header. PAL and extended/interleaved images
remain outside its qualified timing profile and are rejected before room creation.

## Remaining limits

These gates qualify the original fixtures and matching Linux/WASM builds. They do not establish compatibility with every commercial title, Android or Windows native builds, all RTC/cartridge peripherals, or waveform-identical audio replay. A running browser AudioContext is an output-path check, not an audible-quality assessment. The standalone build scripts do not install assets; the RomM adapter separately selects the qualified packages and room flow.
