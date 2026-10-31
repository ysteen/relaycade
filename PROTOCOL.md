# Netplay bridge protocol 1

The bridge runs separately from RomM. It does not execute a core. A browser in slot 0 supplies the authoritative state. Every participant runs the complete emulation locally: linked handhelds for GB/GBA, or one console with two joypads for SNES.

## Administration

All `/v1/rooms` HTTP requests require `Authorization: Bearer <NETPLAY_BRIDGE_ADMIN_TOKEN>`.

- `POST /v1/rooms`: `{system, coreName, coreVersion, contentCrc, stateSize, players, nativeAllowed, owner?, romId?, nickname?, password?, nativeCalibration?, maxPrediction?}`. Systems are `gb` (2 players), `gba` (2 to 4), and experimental `snes` (2). The content CRC is an unsigned integer. Core state size is 1 to 16 MiB. `nativeAllowed` defaults to false. An omitted password is generated. Returns `{id, hostToken, hostPath, tcpPort, password, players}`. `tcpPort` is null for web-only rooms.
- `POST /v1/rooms/:id/join`: `{owner?, nickname?, password?}` reserves a web slot and returns `{id, player, peerToken, peerPath, players, tcpPort, password}`. The password must match when the room has one.
- `GET /v1/rooms`: array of room metadata. Credentials are omitted.
- `DELETE /v1/rooms/:id`: closes the room and all its connections.
- `GET /health`: unauthenticated health status.

RomM supplies public hostnames. Browser paths are relative to the public bridge base URL. Connection tokens are single use and expire after 60 seconds. A nonempty owner may host only one active room.

## Browser connection

Connect to `hostPath` or `peerPath` with WebSocket. The bridge sends `{t:"joined", player, players}`. Slot 0 is the host. JSON messages are text frames. State and battery data are each one binary frame immediately following their JSON header.

1. Host sends `{t:"state", f:0, size, sram:"<base64 memory ID 0>"}`, followed by the raw `retro_serialize` bytes.
2. Bridge replies `{t:"state-ready", revision, f}` to the host. Host sends `{t:"ready", revision}`.
3. Every web guest sends `{t:"battery", size}` and its battery bytes, including an empty binary frame when size is zero. The bridge forwards both to the host, adding `player` to the header.
4. Host imports that battery into its corresponding slot and sends a new state, adding `batteryPlayer` to the header. The bridge broadcasts `{t:"state", f, size, revision}` and bytes to guests. Each guest loads it and replies `{t:"ready", revision}`.
5. Once every reserved slot is connected, web guests have supplied batteries, everyone acknowledges the latest state, and native peers have requested play, the bridge sends `{t:"start", f:0, player, players, maxPrediction}` to each browser. Native clients receive the latest state and controller assignments first.

SNES uses the host's shared cartridge save. Its web guests must send an empty
battery transfer; a guest's independent save cannot replace the shared console's
state. The host still acknowledges the empty transfer and distributes its state
through the same start barrier. The RomM adapter uses this same shared-save rule for SNES rooms.

### Experimental rollback negotiation

`maxPrediction` defaults to zero, preserving lockstep and native slave input sampling.
An integer from 1 to 30 enables bounded web prediction and ordinary native playing
mode. Each `BridgeConnection` must explicitly opt into the same window; a mismatched
start packet closes the connection. Startup-only SameBoy calibration cannot be
combined with prediction. Use matching cores proven to restore after incorrect
predicted input, not just cores that synchronize during forward execution.

The web client retains actual and predicted input separately, reloads the state
before a corrected frame and replays without presentation or duplicate network
input. Progress may advance while confirmation waits. Confirmation is monotonic
and cannot exceed any player's submitted input. CRCs and state exports refer only
to confirmed frames. The client stalls at the prediction limit, bounds snapshot
memory to 64 MiB, and extracts battery saves from confirmed state. Native input
keeps its original frame number with the initialization offset removed. Buffered
startup input is delivered only after all web start messages.

Native runtime resynchronization is not implemented for rollback rooms. A native
state request after startup closes such a room as incompatible, rather than
silently continuing with a partially rewound session. Legacy lockstep recovery
retains its existing behavior.

After start:

| Direction       | Message                            | Meaning                                                                                                                 |
| --------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Peer to bridge  | `{t:"input", f, b}`                | One sequential frame, 16-bit joypad bits. Frames start at zero.                                                         |
| Bridge to peers | `{t:"input", f, b, player}`        | Confirmed input from another slot.                                                                                      |
| Peer to bridge  | `{t:"progress", f, confirmed}`     | Next frame to execute and next fully confirmed frame.                                                                   |
| Peer to bridge  | `{t:"crc", f, crc}`                | CRC32 of the raw state before frame `f`.                                                                                |
| Bridge to host  | `{t:"state-request", f}`           | Capture confirmed state before exactly `f`; inputs at and after this frame are held from native clients until supplied. |
| Host to bridge  | `{t:"state", f, size}` plus binary | Requested state. State sizes must match the room manifest.                                                              |
| Peer to bridge  | `{t:"pause", paused}`              | Pause or resume the whole room.                                                                                         |
| Bridge to peers | `{t:"pause", paused}`              | Apply session pause.                                                                                                    |
| Bridge to peer  | `{t:"error", message}`             | Fatal validation or synchronization failure.                                                                            |
| Bridge to peers | `{t:"disconnect", message}`        | Room closed.                                                                                                            |

The bridge compares web peer CRCs against the host. Checkpoint frames cannot move
backward within a peer's stream or fall more than 600 frames behind the newest
accepted checkpoint. Identical duplicates are allowed; conflicting duplicates
fail. This bounds retained checkpoint history even when peers arrive unevenly.
Native clients validate host CRCs using RetroArch and request state on mismatch.
A repeated native resync loop is treated as incompatibility, not successful
synchronization. Guest disconnects close a running room. Reset, spectators, late
joining and host migration are not supported by protocol 1.

## Native clients

Only rooms explicitly marked `nativeAllowed` open a TCP listener. Connect ordinary RetroArch to the published hostname and `tcpPort`, using the room password and matching core/content/options. RetroArch wire protocols 5 to 7 are supported. Each peer gets one digital joypad and an available slot. Lockstep rooms use RetroArch's existing slave mode: the host samples their latest input for each frame and echoes the assigned input back. Rollback rooms use ordinary playing mode and preserve the native input frame numbers. The bridge advertises the browser's WASM32 little-endian platform layout, so platform-dependent cores can reject incompatible sessions. Core compatibility must be established separately from transport compatibility.

The native start barrier includes a neutral initialization frame. Native wire frame numbers are browser frame numbers plus one. Native input frame 1 acknowledges completion of the bootstrap before the host state and browser start event are sent. This transport barrier does not prove stock core serialization completeness; the compatibility limitations in [README.md](README.md) apply. Native state recovery reloads native peers only. A pre-start native connection error emits `{t:"peer-error", player, message}` and departure emits `{t:"peer-left", player, message}` so a browser can wait for a replacement guest.

### Qualified SameBoy startup calibration

An optional `nativeCalibration: "sameboy-v1"` manifest field is accepted only for native-enabled two-player GB rooms using `SameBoy` / `1.0.4 c87d256`. Web-only participants in such a room use the normal web barrier. If a PC joins, browser start is held while the bridge requests two original native states at wire frames 1 and 2, separated by one neutral confirmed frame. No host state is loaded into the PC during these captures.

The host receives `{t:"native-calibration", player:1, stage:0, size}` plus binary bytes, followed by the same header with `stage:1` and the next snapshot. The browser preserves its existing authoritative state, performs bounded cold replay to align the stock core's omitted runtime with the first native snapshot, imports that native snapshot, and proves exact full-state equality with the second snapshot after one neutral frame. It then reloads its preserved authoritative state and sends `{t:"native-ready"}`. Calibration failure closes the browser connection and room.

Only after this acknowledgement does the bridge send the preserved host state to the PC at native wire frame 2, issue a one-frame RetroArch `STALL` so the load is applied before emulation, and start the browser at logical frame 0. The native frame offset for this profile is therefore 2. Batteries imported before the barrier remain in the authoritative host state. Unsupported or ambiguous calibration must fail explicitly; a partial hash match is not treated as proof of state equivalence.
