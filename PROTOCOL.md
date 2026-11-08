# Netplay bridge protocol 1

The bridge runs separately from RomM. It does not execute a core. The elected browser host supplies the authoritative state. Every participant runs the complete emulation locally: linked handhelds for GB/GBA, or one console with two joypads for SNES. Wire player IDs stay fixed within a connection; the waiting room can assign different emulated controller or console numbers. The first browser receives wire ID 0. Host authority can transfer independently of wire IDs.

## Administration

All `/v1/rooms` HTTP requests require `Authorization: Bearer <NETPLAY_BRIDGE_ADMIN_TOKEN>`.

- `POST /v1/rooms`: `{system, coreName, coreVersion, contentCrc, stateSize, players, nativeAllowed, owner?, romId?, nickname?, password?, nativeCalibration?, maxPrediction?, manualStart?}`. Systems are `gb` (2 players), `gba` (2 to 4), and experimental `snes` (2). The content CRC is an unsigned integer. Core state size is 1 to 16 MiB. `nativeAllowed` and `manualStart` default to false. An omitted password is generated; an explicit empty string creates a passwordless room. RomM sends the empty string for a blank creation field. Returns `{id, hostToken, hostPath, tcpPort, password, players}`. `tcpPort` is null for web-only rooms.
- `POST /v1/rooms/:id/join`: `{owner?, nickname?, password?}` reserves a web slot and returns `{id, player, peerToken, peerPath, players, tcpPort, password}`. The password must match when the room has one.
- `GET /v1/rooms`: array of room metadata. Credentials are omitted.
- `DELETE /v1/rooms/:id`: closes the room and all its connections.
- `GET /health`: unauthenticated health status.

RomM supplies public hostnames. Browser paths are relative to the public bridge base URL. Connection tokens are single use and expire after 60 seconds. A nonempty owner may host only one active room.

## Browser connection

Connect to `hostPath` or `peerPath` with WebSocket. The bridge sends `{t:"joined", player, players}`. Slot 0 is the initial host. JSON messages are text frames. State and battery data are each one binary frame immediately following their JSON header.

1. Host sends `{t:"state", f:0, size, sram:"<base64 memory ID 0>"}`, followed by the raw `retro_serialize` bytes.
2. Bridge replies `{t:"state-ready", revision, f}` to the host. Host sends `{t:"ready", revision}`.
3. Every web guest sends `{t:"battery", size}` and its battery bytes, including an empty binary frame when size is zero. The bridge forwards both to the host, adding `player` to the header.
4. Host imports that battery into its corresponding slot and sends a new state, adding `batteryPlayer` to the header. The bridge broadcasts `{t:"state", f, size, revision}` and bytes to guests. Each guest loads it and replies `{t:"ready", revision}`.
5. Once every reserved slot is connected, web guests have supplied batteries, everyone acknowledges the latest state, and native peers have requested play, the bridge sends `{t:"start", f:0, player, players, maxPrediction}` to each browser. Native clients receive the latest state and controller assignments first.

### Waiting room

With `manualStart: true`, the joined message also contains `{manualStart:true, host, generation, running}`. The host sends its initial state for native handshakes, but guest battery exchange and the start barrier wait for the host's start request. Waiting rooms expire after 30 minutes if they never start. Browser messages include the current `generation`; packets from an older game are consumed and ignored.

- The bridge broadcasts `{t:"lobby", players, seats, host, running, starting, canStart, members}`. `seats[wirePlayer]` is a zero-based emulated controller/console number or `null`. Every arriving member starts unassigned. Members contain `{player, nickname, kind, ready, playing, ping}`.
- A browser sends `{t:"assign", player, seat}` to select or clear a number. Guests may change only their own assignment; the elected host may change any waiting member. Occupied numbers cannot be reassigned until cleared. Active players keep their existing numbers while a game is running.
- Only the elected host may send `{t:"start-request"}`. The first start requires every slot to connect. Later starts require a waiting participant and every connected member to choose an available number. Rejected lobby actions return `{t:"action-error", message}` without closing the room.
- The bridge freezes assignments and broadcasts `{t:"prepare", seats, host, generation, restarting}` with an increased generation. Clients export battery data from the last confirmed state, reset to the initial core snapshot, and import those batteries into the assigned consoles. New guests supply their own selected save. SNES retains the current host's shared memory ID 0 and guests send empty batteries. The normal latest-state barrier above then starts play at frame zero.
- Input messages retain wire player IDs. Browser clients route inputs to the assigned emulated devices, and native MODE messages carry the matching controller masks. Choosing P2 does not transfer host authority.
- Departure frees the member's number and slot. Remaining players keep running with sequential neutral inputs for that wire ID. The last departure removes the room. Host departure transfers controls and ownership to another active browser, or a waiting browser if no active browser remains. Native-only games continue; a browser must rejoin to control the next restart.
- New members may join a running room, choose a free number, and wait. Existing players continue until the host explicitly restarts. If only native players remained, the bridge requests a current native snapshot and sends `{t:"restart-source", size}` plus bytes to the new browser host to preserve their battery progress.
- Heartbeats run every two seconds. Browsers echo `{t:"ping", nonce}` as `{t:"pong", nonce}`; native clients use RetroArch PING/PONG. `{t:"latency", members:[{player,ping}]}` reports smoothed round-trip milliseconds to the relay, not peer-to-peer or emulation latency. Unmeasured or stale values are `null`. A peer silent for 15 seconds is removed individually.
- A waiting native client has no handshake timeout after completing PLAY; the room's setup deadline still applies.

When `manualStart` is false, wire IDs map directly to emulated numbers and the existing automatic start behavior remains available.

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
synchronization. Legacy automatic-start rooms close on departure. Manual rooms
support the departure and restart flow above. Spectators and seamless mid-game
joining without a reset are not supported.

## Administration dashboard API

All management endpoints use the existing service bearer token. RomM checks its administrator role before proxying them; the service token must never be sent to a browser.

- `GET /v1/rooms/admin`: runtime settings, transport information, active-room summaries and save queue metadata. Save bytes and room credentials are omitted.
- `PUT /v1/rooms/admin/settings`: `{roomsEnabled, maxRooms, saveIntervalSeconds}`. Capacity is bounded by the configured service capacity; interval is 5 to 120 seconds. Settings are stored in `NETPLAY_BRIDGE_SAVE_DIR/settings.json`. Disabling creation or lowering capacity preserves active rooms.
- `GET /v1/rooms/admin/logs?after=<sequence>`: `{events, cursor, startedAt}` with up to 500 retained events. Each event contains `{id, time, event, fields}`. Clients reset their cursor when `startedAt` changes. Credential and binary payload fields are omitted.

## Server save queue

Authenticated manual-start rooms can opt into durable save storage with `NETPLAY_BRIDGE_SAVE_DIR`. The adapter supplies `saveAllowed: true` for each account allowed to write saves, in the room creation, join or native preparation request. It also supplies `saveSize` (0 to 131072 bytes) when creating SNES rooms. Pinned supported formats are listed in [server save synchronization](docs/save-sync.md).

The `joined` message advertises `serverSaves`. Lobby metadata includes `saves: {enabled, pending, synced, error}`; changes are also sent as `{t:"save-status", ...saves}` to playing browsers and native room controllers. Web clients send `{t:"save-state", id, f, size, generation}` followed by a confirmed snapshot. The broker returns `{t:"save-stored", id, error?}` only after queuing it durably, or with a storage error. Automatic web collection reuses `resume-source`/`resume-state`. Native collection reuses stock RetroArch REQUEST_STATE/LOAD_STATE.

REQUEST_STATE rebases stock RetroArch's rollback history and returns a current, potentially predicted state. In native-only rooms the bridge reserves the other native clients' outgoing input boundaries before requesting it. It waits for the source to reach that boundary, forwards queued inputs before the returned logical frame, advances missing wire-server frames with NOINPUT, sends LOAD_STATE, then forwards later inputs. The logical game generation does not change. Native snapshots are authoritative state transfers, not confirmed CRC samples. Web-confirmed CRC messages still use the existing verification path. Diagnostic events `native-checkpoint` and `native-state-relayed` record the generation, logical frame and source/receiving player, without state bytes or credentials.

A future LOAD_STATE advances the receiver's expected logical and wire input counters to that state boundary. Older inputs still in flight are ignored; later inputs must remain sequential. `native-input-rebased` records this authorized advance, and `native-input-gap` records unexpected gaps. Lobby keepalives stop as soon as a native peer has bootstrapped, including the interval while other participants finish preparing, so they cannot advance the initial state's wire boundary.

The administrative `GET /v1/rooms/save-queue?room=<optional-room-id>` returns up to eight pending entries. Each contains `{id, revision, roomId, owner, player, romId, coreName, generation, frame, battery, error}`, where battery is base64 SRAM bound to the frozen original participant. `POST /v1/rooms/save-queue/:id` with `{revision, error?}` acknowledges only that revision. A nonempty error keeps it pending for retry. A successful acknowledgement removes it; an obsolete revision returns `acknowledged: false`. These endpoints require the service token and remain available after room deletion.

## Native clients

Only rooms explicitly marked `nativeAllowed` open a TCP listener. Connect ordinary RetroArch to the published hostname and `tcpPort`, using the room password and matching core/content/options. RetroArch wire protocols 5 to 7 are supported. Each peer gets one digital joypad and an available slot. Lockstep rooms use RetroArch's existing slave mode: the host samples their latest input for each frame and echoes the assigned input back. Rollback rooms use ordinary playing mode and preserve the native input frame numbers. The bridge advertises the browser's WASM32 little-endian platform layout, so platform-dependent cores can reject incompatible sessions. Core compatibility must be established separately from transport compatibility.

The initial native start barrier includes a neutral initialization frame. Native wire frame numbers initially equal browser frame numbers plus one. Native input frame 1 acknowledges completion of the bootstrap before the host state and browser start event are sent. On a room restart, a bounded PING/PONG barrier drains old input, NOINPUT advances the server clock if needed, and LOAD_STATE restarts the existing TCP connection with a new frame offset. The restart does not add a STALL that could suppress the required post-frame advance. This transport barrier does not prove stock core serialization completeness; the compatibility limitations in [README.md](README.md) apply. Native state recovery reloads native peers only. A native connection error emits `{t:"peer-error", player, message}` and departure emits `{t:"peer-left", player, message}` so a browser can keep playing or wait for a replacement guest.

### Qualified SameBoy startup calibration

An optional `nativeCalibration: "sameboy-v1"` manifest field is accepted only for native-enabled two-player GB rooms using `SameBoy` / `1.0.4 c87d256`. Web-only participants in such a room use the normal web barrier. If a PC joins, browser start is held while the bridge requests two original native states at wire frames 1 and 2, separated by one neutral confirmed frame. No host state is loaded into the PC during these captures.

The host receives `{t:"native-calibration", player:1, stage:0, size}` plus binary bytes, followed by the same header with `stage:1` and the next snapshot. The browser preserves its existing authoritative state, performs bounded cold replay to align the stock core's omitted runtime with the first native snapshot, imports that native snapshot, and proves exact full-state equality with the second snapshot after one neutral frame. It then reloads its preserved authoritative state and sends `{t:"native-ready"}`. Calibration failure closes the browser connection and room.

Only after this acknowledgement does the bridge send the preserved host state to the PC at native wire frame 2, issue a one-frame RetroArch `STALL` so the load is applied before emulation, and start the browser at logical frame 0. The native frame offset for this profile is therefore 2. Batteries imported before the barrier remain in the authoritative host state. Unsupported or ambiguous calibration must fail explicitly; a partial hash match is not treated as proof of state equivalence.

## Cable input profile

Exact SameBoy `1.0.4c87d256-cable1` and mGBA Splitscreen `0.1.0-f1d5975-cable1` identities select `link-cable-r3-v1`. Room metadata and the web `joined` message expose `inputProfile`. In this profile, `0x8000` in a console's joypad input means its cable is detached. The broker alone supplies this bit for departed members, after their accepted inputs. Active clients must never submit it. Browser local prediction masks physical R3; the launcher disables that binding in its isolated native configuration.

The ordinary native INPUT packet carries the marker. Core-version matching rejects older native builds. Remaining replicas replay the same level-triggered value through rollback and snapshots. Reconnection follows snapshot admission at the first new live input. Retained idle room members receive zero input and keep their cable attached. SNES and older core identities use the existing input profile.
