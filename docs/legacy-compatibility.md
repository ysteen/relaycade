# Historical integration prototype

This is the compatibility record before extraction. Current operation and paths are documented in the [project README](../README.md).

# Separate netplay gateway

This service relays inputs for linked GB/GBC (2 players), GBA (2–4 players), and experimental SNES (2 joypads). Each participant runs the emulation locally. RomM keeps its existing netplay implementation; the new service is optional and uses a separate API and container. The browser in slot 0 supplies the initial authoritative state. The gateway runs no emulator and stores no ROMs or saves on disk.

## Compatibility status

### Experimental rollback profiles

See the [core qualification catalog](core-qualification.md) for reproducible
build commands, artifact paths, recorded results, and remaining validation limits.

Qualification proceeds in order: SameBoy, mGBA Splitscreen, then Snes9x.
The shared session engine predicts up to the negotiated `maxPrediction` limit,
restores late-input frames, replays without presenting duplicate audio/video,
and exports SRAM only from confirmed state. The existing catalog remains
lockstep; do not enable prediction on its calibration-only SameBoy profile.

| Core             | Qualified build profile                                    | Emulation model                                     |
| ---------------- | ---------------------------------------------------------- | --------------------------------------------------- |
| SameBoy          | `1.0.4c87d256-rollback2`, state trailer `SBR2`             | Two linked GB/GBC consoles                          |
| mGBA Splitscreen | `0.1.0-f1d5975-rollback1`, state `SPST4`                   | Linked GBA consoles                                 |
| Snes9x           | Pinned upstream `2d4cce69f4fe1c53a2c1423cdc06f2dea8b870a1` | One console, two joypads, one shared cartridge save |

The versioned `SBR2` SameBoy patch preserves APU scheduling counters and joypad
history omitted by the original state format. Joypad history is necessary when
restoring after an incorrect prediction, even if ordinary forward replay matches.
Both native and WASM must use the same patched core. Its states are not compatible
with the stock core or the earlier experimental SBR1 format.

`scripts/build-retroarch-compat-sameboy.sh` builds into a fresh isolated directory
using at most two compiler jobs. It verifies the source archive and boot ROMs,
records artifact hashes, and optionally builds the full browser package with
`COMPAT_BUILD_WEB=1`. It requires the prepared toolchain/source inputs documented
by its `COMPAT_*` variables and never replaces the installed production core.

mGBA's matching native/WASM patch preserves link event queues, serial latches,
audio phase and restore ordering. Its `SPST4` states are incompatible with the
older upstream and browser link formats. Build it with
`scripts/build-retroarch-rollback-mgba.sh`; use `COMPAT_BUILD_WEB=1` for the packaged
browser frontend. It retains the identical-ROM restriction. Core restoration is
tested with 2, 3 and 4 consoles; the initial rollback multiplayer gate uses two
participants.

Qualification harnesses are:

- `test/sameboy-state-replay.py`: native/WASM cross-history restoration, deliberately
  incorrect predicted inputs, seeded cartridge SRAM and invalid state rejection.
- `test/web-rollback-smoke.mjs`: two real WASM rollback sessions compared against
  an independent third execution, including confirmed states, battery data,
  wrong-input restoration and a control that removes each player's inputs.
- `test/browser-rollback-smoke.mjs`: two isolated Chrome pages running the full
  EmulatorJS package, with local rendering and audio, compared to a third core.
- `test/native-smoke.mjs`: an unmodified RetroArch application over real TCP and
  WebSocket connections, with selectable core/probe paths and delayed inputs.
- `test/mgba-native-smoke.mjs` and `test/snes-native-smoke.mjs`: corresponding
  mixed web/PC runs, with fixture SRAM proving the native joypad affects emulation.

Select the WASM/browser harness with
`NETPLAY_TEST_CORE=sameboy|mgba_splitscreen|snes9x`. The WASM harness also takes
`NETPLAY_TEST_WASM`, `NETPLAY_TEST_OUTPUT`, `NETPLAY_TEST_BATTERY_SEED`, and an
explicit fixture path. Generate the original SNES diagnostic with
`python3 test/make-snes-fixture.py /path/to/two-pad.sfc`.
The browser harness injects deterministic delay between local sessions; the native
harness separately tests actual TCP/WebSocket transport.

The native harness accepts `NETPLAY_TEST_NATIVE_CORE`, `NETPLAY_TEST_WASM`,
`NETPLAY_TEST_CORE_VERSION`, `NETPLAY_TEST_MAX_PREDICTION`,
`NETPLAY_TEST_INPUT_LATENCY_MS`, and `NETPLAY_TEST_NATIVE_INPUT_LAG_FRAMES`.
Disable startup calibration with `NETPLAY_TEST_CALIBRATION=off` for this profile.
`NETPLAY_TEST_REMOTE_INPUT=1` exercises native button presses; delayed-input runs
must observe actual rollbacks. Progress and final JSON separate frame count,
wall-clock duration, CRC delivery, rollback counts, and battery preservation.

These are diagnostic homebrew qualification tests on Linux x86_64. Production
catalog enablement, Android device support and commercial-game coverage require
their own evidence. The RomM room UI currently exposes handheld profiles; SNES
uses the broker and qualification harness pending its product UI integration.

### Existing lockstep profiles

Browser room creation, per-player battery exchange, latest-state start barriers, input routing, CRC checks, and disconnect handling are implemented. Native RetroArch protocol 5–7 handshakes, password authentication, controller mapping, slave-mode input, compressed state envelopes, and state requests are implemented and covered by real TCP tests.

**Stock PC SameBoy uses an explicit, version-pinned calibration profile.** Set `nativeCalibration: "sameboy-v1"` together with `nativeAllowed: true` only for a matching SameBoy 1.0.4 c87d256 two-player room. The bridge captures two original PC states, the browser aligns omitted core runtime using bounded neutral replay, and an exact next-frame comparison must pass before play starts. The host's original state and previously imported batteries are then restored on both sides. Actual Chrome with the packaged WASM frontend and untouched RetroArch 1.22.2 plus stock SameBoy passed 660 host frames and 11 checks with a 500 ms handshake delay. The Node probe passed over 600 frames with ten checks at both 1000 ms and 1800 ms delays. A Game Boy Color fixture with distinct nonzero 32 KiB saves in both slots passed 601 browser-host frames, 603 native frames and ten checks delivered after the native frame existed; both save patterns survived calibration. This is an experimental game profile; matching ROMs, core options, 48000 Hz audio in both frontends, and neutral controls during initial connection are required. The WASM package must carry the 48000 Hz metadata as well as the matching core; changing only native RetroArch audio settings is insufficient.

Without calibration, stock SameBoy omits audio runtime state and startup timing depends on connection latency. A fixed warmup count is insufficient. Unsupported/ambiguous calibration or repeated CRC mismatches fail explicitly. Uncalibrated SameBoy rooms remain diagnostic only.
**mGBA Splitscreen uses the upstream core with one initialization declaration.** The unmodified 0.1.0 core returns a zero state size before its first frame and omits `MUST_INITIALIZE`, so ordinary RetroArch netplay startup fails before connecting. The [minimal core patch](../patches/mgba-must-initialize.patch) declares that requirement. Both the PC and compatible WASM core use upstream revision `f1d5975d77285f77affbfe64b7050ebd5c4b6a77`; no link-state or emulation patch is applied. The browser frontend waits for initial core construction and forwards up to four controllers.

Actual Headless Chrome sessions with untouched RetroArch 1.22.2 and the initialization-only PC core passed these homebrew cable tests:

| Room               | Progress                                        | Native checks | Recovery requests |
| ------------------ | ----------------------------------------------- | ------------- | ----------------- |
| One web + one PC   | 689 web / 691 PC frames, 500 ms handshake delay | 11            | 0                 |
| Two web + one PC   | 737 web / 739 PC frames, 500 ms handshake delay | 12            | 0                 |
| Three web + one PC | 899 shared web / 901 PC frames                  | 15            | 0                 |

Web snapshots matched across participants; keyboard/gamepad input, per-web-player battery content, save API requests, pause and volume controls passed. The Node WASM probe additionally matched three complete PC snapshots at each of 0, 500 and 1800 ms handshake delays. These tests qualify the homebrew workload on Linux x86_64, not all commercial games or Windows builds. The mixed browser tests used neutral PC controls and varied web controls. The browser harness supplies fixture ROM metadata and captures save requests; the cores, gateway and PC frontend run normally. Backend permission/proxy tests are separate.

A separate bidirectional test used stock RetroArch's Remote RetroPad input, without a frontend or further core patch. Three PC-side A presses arrived as nonzero native input packets, reached the WASM console's battery counter exactly three times, and retained 11 matching CRC checks plus three exact native/WASM snapshots over 660 frames.

The current official 2026-10-28 RetroArch nightly (`d2db43b`) also passed 667 web-probe frames, 665 native frames, 11 native checks and three full-state comparisons with a 500 ms handshake delay, using the same initialization-only PC core.

The native-compatible GBA profile uses upstream state version 1. Original browser link rooms retain their patched version-3 core, including support for separate cartridges. Native rooms require identical ROM bytes and the compatible build on every participant. Arbitrary runtime state recovery remains unqualified, so CRC checks and the repeated-recovery limit stay enabled.

Existing patched browser link cores and the original RomM sessions remain available. The PC RetroArch frontend is unmodified; SameBoy is stock, and mGBA Splitscreen has only the initialization declaration.

## Run locally

Use Node 24 or newer:

```sh
cd netplay-bridge
npm ci --ignore-scripts
NETPLAY_BRIDGE_ADMIN_TOKEN='<at least 24 random characters>' npm start
```

The HTTP service listens on port 8080. Room-specific native TCP listeners use ports 55435–55442 only when explicitly enabled. `NETPLAY_BRIDGE_BIND`, `NETPLAY_BRIDGE_HTTP_PORT`, `NETPLAY_BRIDGE_TCP_START`, and `NETPLAY_BRIDGE_TCP_END` override those defaults. `NETPLAY_BRIDGE_ORIGINS` is a comma-separated list of allowed browser origins; configure it when exposing WebSocket connections publicly.

For a separate container, set `NETPLAY_BRIDGE_TOKEN` in the environment and run from the repository root:

```sh
docker compose -f docker/compose.netplay-bridge.yml up -d --build
```

The compose file maps that shared token to the service's `NETPLAY_BRIDGE_ADMIN_TOKEN`. It publishes HTTP on `127.0.0.1:8082` and the TCP range on loopback by default, uses one CPU and 256 MiB, and runs as a non-root user with a read-only filesystem. Set the bind addresses for the intended network. Public browser connections require a reverse proxy supporting HTTPS/WebSocket upgrade; restrict direct administrative HTTP access. Never put the admin token in browser JavaScript.

RomM's backend uses `NETPLAY_BRIDGE_URL` for the internal HTTP endpoint, `NETPLAY_BRIDGE_TOKEN` for authentication, and `NETPLAY_BRIDGE_PUBLIC_URL` for the browser-facing base URL. See [PROTOCOL.md](../PROTOCOL.md) for the exact API. This compose file creates its own network; attach it to the RomM network or supply an address reachable from the RomM backend.

## Verification

[Relaycade CI](../.github/workflows/verify.yml) runs transport/session
tests, builds the dedicated Docker image and checks container startup on pull
requests or manual dispatch. It does not publish an image. Emulator qualification
requires separately built core artifacts and is not replaced by this CI job.

```sh
cd netplay-bridge
node test/bridge.test.mjs
```

Tests open isolated ephemeral TCP/HTTP ports and exercise actual sockets, including fragmented RetroArch headers, versions 5/6/7, compressed states, passwords, four-player battery exchange, owner limits, and CRC failure. They do not substitute for a real emulator compatibility test. The native smoke harness is `test/native-smoke.mjs`; it requires separately obtained stock binaries and the generated core probe. Its source is [test/libretro-probe.c](../test/libretro-probe.c). The artifact directory must contain `core-probe.mjs`, `core-probe.wasm`, `native/sameboy_libretro.so`, `native/squashfs-root/AppRun`, and the isolated baseline files `native/client/options.cfg` and `native/client/retroarch.cfg`. It intentionally fails when CRC recovery occurs:

```sh
NETPLAY_TEST_ARTIFACTS=/path/to/stock-core NETPLAY_TEST_HANDSHAKE_DELAY_MS=1000 node test/native-smoke.mjs
```

Set `NETPLAY_TEST_CALIBRATION=off` to reproduce the original startup-state failure. The harness writes a JSON result and native log under its isolated output directory and terminates the native process afterward. `NETPLAY_TEST_ROM` selects a different homebrew fixture; `NETPLAY_TEST_OUTPUT` selects an isolated output directory. For a fixture with 32 KiB RAM, `NETPLAY_TEST_BATTERY_SEED=49` seeds distinct patterns into both serialized cartridge RAM regions before connection and verifies them afterward. This tests preservation of the authoritative save state; the separate browser tests cover the battery import API.

The browser starts at logical frame 0. Calibrated SameBoy startup uses two neutral native frames and an internal frame offset of two; GBA and generic diagnostic rooms use one. A PC that connects before the host's initial snapshot waits for the snapshot and SRAM before receiving SYNC. Native clients use RetroArch slave mode and wait for confirmed input, avoiding prediction and rollback during normal play. Runtime state recovery only reloads native peers; already synchronized web peers remain in lockstep. A mismatched stock-core runtime may not recover from a state load, so repeated recovery is rejected.

## Reproduce the GBA profile

Run [scripts/build-retroarch-compat-mgba.sh](../scripts/build-retroarch-compat-mgba.sh) from the workspace with the prepared EmulatorJS frontend and Emscripten toolchain. The script builds in an isolated directory with two jobs, pins and verifies the upstream source archive, applies the same initialization declaration to both cores, and adds four-controller forwarding only to the browser frontend. Existing production cores are not overwritten.

The qualified Linux PC core SHA-256 is `5b50ecffb49cc2ff0e2bb0d8a1005a9f707eab65144fee55d30556b69cff5560`. The compatible WASM SHA-256 is `a673e06c0a7ccb8091c0130a03dff6f4f82968864dd51354d2bb86a4351451bb`; its packaged core SHA-256 is `9f84a51153b205bbd7706f3db5bf2003eb5fad2a0c8f2a11aed1e4accbca2bbb`.

[test/mgba-native-smoke.mjs](../test/mgba-native-smoke.mjs) exercises real TCP/WebSocket transport, stock RetroArch, the initialization-only native core, varying host input and exact PC/WASM snapshot comparison. Set `NETPLAY_TEST_ARTIFACTS` to a directory containing `gba-probe.mjs`, `gba-probe.wasm`, `mgba-initialize-build/mgba_splitscreen_libretro.so`, and `native/squashfs-root/AppRun`; the native options/config baseline is `native/gba-initialize-client`. The probe source is [test/mgba-core-probe.c](../test/mgba-core-probe.c), linked with the upstream WASM core archive. For example:

```sh
NETPLAY_TEST_ARTIFACTS=/path/to/stock-core node test/mgba-native-smoke.mjs 2 1 500
```

`NETPLAY_TEST_RETROARCH` selects another untouched frontend executable, and `NETPLAY_TEST_OUTPUT` selects the evidence directory. Set `NETPLAY_TEST_REMOTE_INPUT=1` to exercise PC-side A presses using RetroArch's standard Remote RetroPad UDP interface on an isolated test port. The isolated browser runtime is managed by [scripts/headless-browser.mjs](../scripts/headless-browser.mjs); its [usage guide](../scripts/HEADLESS_BROWSER.md) covers persistent binaries and automatic cleanup. Keep Chrome closed during builds.
