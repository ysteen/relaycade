# RetroArch Netplay Bridge

A self-hosted input relay for browser cores and unmodified RetroArch clients. Each participant runs the emulation locally. A RetroArch or browser host supplies the initial state; late inputs are corrected by bounded rollback. The service relays input and snapshots without running emulator sessions or streaming video. Its optional durable save queue lets RomM synchronize each original participant's cartridge save, including in native-only rooms.

| Core             | Required version               | Players                         |
| ---------------- | ------------------------------ | ------------------------------- |
| SameBoy          | `1.0.4c87d256-cable1` (SBR3)   | Two linked GB/GBC consoles      |
| mGBA Splitscreen | `0.1.0-f1d5975-cable1` (SPST5) | Two to four linked GBA consoles |
| Snes9x           | `1.632d4cce69`                 | One SNES, two joypads           |

The first two cores require matching native/WASM patches. Snes9x uses the pinned upstream core. All replicas load the same ordered cartridge set and matching options. GB/GBC and GBA participants may bring different cartridges before game preparation. Linux x86_64, Windows x64/x86/ARM64 and four Android ABIs are available through the RomM adapter. See [native builds and verification limits](docs/native-builds.md) and [core qualification results](docs/core-qualification.md).

## Documentation

- [Install RomM and bridge on another server](https://github.com/ysteen/romm/blob/custom/netplay-retroarch-bridge/docs/NETPLAY_INSTALL.md): portable images, runtime assets, HTTPS, verification, updates and backups.
- [Player guide](https://github.com/ysteen/romm/blob/custom/netplay-retroarch-bridge/docs/ROLLBACK_ROOMS.md): rooms, automatic Windows core setup, saves and rejoin.
- [Administration](docs/administration.md): bridge-owned dashboard, RomM administrator authentication and the adapter contract.
- [Core builds](docs/native-builds.md), [room lifecycle](docs/room-lifecycle.md), [save synchronization](docs/save-sync.md) and [protocol](PROTOCOL.md): maintainer references.
- [Nintendo DS WFC](docs/ds-wfc.md): melonDS DS web port, authenticated network gateway, console identity and qualification limits.

The portable installation bundle is exported from a tested deployment and includes its exact images and code overlays. It does not depend on development paths or a running development server. A published image can lag uncommitted local work; do not assume a source checkout or a mutable image tag includes that work.

## Run the standalone service

With Node 24 or later:

```sh
npm ci --ignore-scripts
export NETPLAY_BRIDGE_ADMIN_TOKEN='<at least 24 random characters>'
export NETPLAY_BRIDGE_SAVE_DIR='./data/saves'
npm start
```

For Docker, copy `.env.example` to `.env`, replace its token and origin, then run:

```sh
docker compose up -d --build
```

The container exposes HTTP on loopback port 8082 and native TCP ports 55435–55442. It runs as a non-root user with a read-only filesystem, one CPU, and a 256 MiB memory limit. Configure the published bind addresses for the intended network. Browser connections require an HTTPS reverse proxy with WebSocket upgrade support. Native clients connect to the native hostname and room port directly.

Native connection diagnostics are JSON records on standard output. Use
`docker compose logs -f netplay-bridge` to follow accepted connections, negotiated
protocols, core/version/ROM CRC comparisons, synchronization and disconnect
reasons. Passwords, login tokens, nicknames and game/state payloads are excluded.
`native-error` includes the handshake phase; `native-core-info` includes the
received and expected ROM CRC values. A CRC mismatch requires identical ROM
bytes, including the same translation patch and revision.

In RetroArch 1.22.2's **Connect to Netplay Host** address prompt, use
`hostname|port`, for example `netplay.example.com|55435`, or configure the server address
and TCP port separately. The prompt does not split `hostname:port`.

SameBoy rooms require RetroArch **1.22.2 or later** for matching native/web audio
scheduling. The Windows launcher asks users to update older installations and
downloads a portable runtime only when none is found. See [native setup](docs/native-builds.md).

## RomM integration

For installation, WebSocket/TCP proxy setup, web invitations and native RetroArch
connection commands, see the [RomM connection guide](https://github.com/ysteen/romm/blob/custom/netplay-retroarch-bridge/docs/NETPLAY_BRIDGE.md).

```mermaid
flowchart LR
    Web[Browser and WASM core] -->|Login, games, saves| RomM[RomM backend]
    RomM -->|Room API and service token| Bridge[Netplay Bridge]
    Web <-->|Inputs and state over WebSocket| Bridge
    Native[RetroArch and native core] <-->|RetroArch TCP protocol| Bridge
```

RomM owns account authentication, game access, room permissions, and save uploads. The bridge accepts administrative requests from the RomM backend using a shared service token. The token stays on the backend. Browser clients receive expiring, single-use connection tokens; native clients use RetroArch's existing room password protocol. No separate OIDC provider is needed for this adapter.

The Compose configuration persists pending saves in the `netplay-saves` volume. RomM consumes that queue using its scheduled task and writes a separate room save for each original account and cartridge. Keep the volume when updating containers. See [server save synchronization](docs/save-sync.md) for formats, retries and verification limits.

RomM rooms use a waiting room with an explicit host start. Everyone initially has no player number. Guests can select their own number; the host can assign anyone's number, including native guests. Numbers must be unique and every slot must be connected and assigned before starting. Leaving the creation password blank creates a passwordless room; web guests still sign in to RomM.

Configure the RomM backend with:

```dotenv
NETPLAY_BRIDGE_URL=http://netplay-bridge:8080
NETPLAY_BRIDGE_TOKEN=<the same shared token>
NETPLAY_BRIDGE_PUBLIC_URL=https://netplay.example.com
NETPLAY_BRIDGE_PUBLIC_HOST=netplay.example.com
```

The internal URL must be reachable from the RomM container, for example through a shared Docker network. The public URL is the browser WebSocket endpoint. The public host is used for native TCP connections. Serve the qualified core packages from RomM's emulator assets and restart RomM after changing backend configuration.

The RomM adapter lives in a separate checkout. This repository owns the reusable browser modules in `client/`; synchronize them into that checkout with:

```sh
node scripts/sync-romm-client.mjs ../romm-retroarch-sync
node scripts/sync-romm-client.mjs ../romm-retroarch-sync --check
```

See [PROTOCOL.md](PROTOCOL.md) for the backend and WebSocket contracts. RomM rooms keep playing when someone leaves, prefer a playing RetroArch as host, then a playing browser, and admit compatible returning participants from live state. The room panel shows each participant's round-trip latency to the relay beside their name. Account-bound rooms use personal native credentials issued through the Windows launcher; invitation passwords are separate.

## Verify and build cores

```sh
npm test
```

The tests use real local HTTP/TCP/WebSocket sockets and deterministic rollback fixtures. They need no RomM checkout or emulator binaries. [CI](.github/workflows/verify.yml) runs these tests, builds the container, and checks startup on pull requests, pushes to `main`, and manual dispatch. It exports an image archive as a workflow artifact; it does not publish a registry tag.

Native/WASM core qualification uses the scripts and external toolchain described in the [artifact catalog](docs/core-qualification.md). Core builds are limited to two compiler workers. Generated packages carry source revisions, hashes, and license metadata.

The optional full browser integration test uses RomM's existing player and persistent browser helper. Set `ROMM_SOURCE` to that checkout, and `NETPLAY_TEST_PATCHED_ARTIFACTS` to a prepared core build before running `node test/browser-rollback-smoke.mjs`. The standalone gateway itself has no RomM runtime dependency.

## Repository layout

- `server.mjs`, `native.mjs`, `wire.mjs`: room service and RetroArch wire adapter.
- `client/`: rollback session engine and core profiles.
- `patches/`, `scripts/`: pinned core patches, builds, and adapter synchronization.
- `test/`: transport tests, original homebrew fixtures, core probes, and emulator checks.
- `docs/`: qualification evidence and compatibility details.

Licensed under AGPL-3.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE). Generated emulator builds retain their upstream licenses.
