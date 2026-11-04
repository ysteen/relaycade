# Room membership, game lifetime and cable ownership

## Implemented room behavior

A browser room owns membership. Its WebSocket stays connected while the Windows launcher prepares RetroArch and while RetroArch plays. The broker keeps this room control connection separately from the native gameplay connection, under the same participant and account. Member counts, player numbers and cartridge ownership do not change during the handoff.

| Action                                           | Room membership                   | Local game                           | Other participants |
| ------------------------------------------------ | --------------------------------- | ------------------------------------ | ------------------ |
| Close RetroArch or its launcher connection       | Retained by the open browser room | Closed                               | Keep playing       |
| Cancel or expire Windows preparation             | Return to the same room           | Not started                          | Keep playing       |
| Web **Save and return to room**                  | Retained                          | Save, release core and show room     | Keep playing       |
| **Leave room**, close room page, or host removal | Removed                           | Connection revoked and core released | Keep playing       |

Returning to the room never starts the web core automatically. The player chooses Web browser or Windows RetroArch and selects Join game again. Closing a launcher during a download cannot be detected immediately without a launcher heartbeat; the room stays in preparation until cancellation or expiry. The browser room remains available throughout.

The retained browser responds to room heartbeats even while its native game is active. Closing that browser revokes both a pending native credential and an active native connection. A cancelled or failed native launch returns to the same browser connection. It does not create another member or free the participant's number.

Older browser clients can finish their existing sessions. The new page requests `retainRoom=1` when opening its WebSocket. Only these clients receive retained handoff and return messages.

## Continuing a Windows client from the running game

Keep the browser room open, choose Windows RetroArch again, and select **Join game**. A ready native participant with a compatible cartridge and assigned console joins automatically; the host does not press Restart. The broker requests a live full-machine snapshot from a playing RetroArch or web participant and briefly synchronizes the active replicas with the new client. This preserves game progress, ordered cartridges, battery data and link state while rebasing protocol frame numbers. Other idle room members remain idle and unassigned numbers stay unassigned. Web rejoin uses a snapshot plus subsequent inputs without the shared barrier.

A snapshot source must remain running. Paused games and busy native state sources defer admission until available. Recovery after every running replica has closed, arbitrary cartridge replacement inside a running snapshot, and all games or player counts are not guaranteed.
The restart barrier drains old inputs through ordered PING/PONG messages. It must not send a forced STALL around the state load: RetroArch 1.22.2 moves to `load_frame - 1` when receiving a future state, expecting its normal post-frame advance. Stalling that advance left the retained native host one emulated frame ahead of the new client and caused the first subsequent CRC check to disconnect it. Startup and ordinary pacing stalls remain separate.

On 2026-11-04, a user-authorized Windows Job Object runner qualified three mGBA Splitscreen cases with the bundled two-cartridge GBA diagnostic fixtures: closing and reopening one native client, and changing a WASM client into a native client while another native host stays connected, and reopening the native host while a web participant keeps playing. Each used exactly one host Start command, for the initial game. All preserved live progress, both cartridge save markers and input-written save counters. Input after rejoining incremented the saved counter again, and native checks at approximately frames 600 and 1200 passed. The mixed tests ran the WASM core and browser protocol in Windows Node, not the browser UI. Each job was limited to 1.5 GiB, two CPU affinity bits and 60 seconds; no emulator ran in WSL. This is a short two-player qualification, not a long-session, all-game or Android qualification.

The prepared Windows assets can be reused with `test/run-windows-continuation.ps1 -Workspace <workspace> -Scenario fresh|rejoin|handoff|web-host`. The wrapper uses `test/windows-bounded.c`'s prebuilt runner and the launcher's real authentication tunnel, creates isolated settings/saves, and writes JSON evidence below `result/netplay-interop/native-continuation-20261104`. Do not run the Node harness directly or move emulator execution back into WSL.

## Selected cartridges and the next game

GB/GBC and GBA rooms collect the cartridge selected on each participant's game page. They have no in-room cartridge picker. Compatible-system cartridges can enter a waiting or running room, including different GB/GBC titles. Names remain visible and the host can remove unwanted participants. Library access rules still apply.

A different cartridge can wait in the room without altering the running set. **Prepare new game**, available to the host once all numbers are assigned, ends the existing game and returns everyone to the same room. Each person selects their client and **Join game** again; the host then selects **Start game** to prepare the new ordered set. Native launch credentials for the old set are revoked. Matching-cartridge rejoin needs neither step. Waiting manual-start rooms have no setup deadline; transport health and authentication credential expiry remain bounded.

## Cable disconnection design, not enabled in current core builds

Room membership and emulated cable attachment are separate state. Current builds fill an inactive participant's input with zero, keeping the virtual console and cable running. The changes above do not yet unplug a cable inside a game.

The target behavior is to keep the cable attached when a participant only closes their game and remains in the room. Explicit room exit, room page closure, a confirmed room connection loss, or host removal detaches that participant's console. Other consoles retain their cartridge, save, emulation state and room connection. SNES has no link cable; it releases only the departing controller's input.

### Apply departures at an emulated frame

The broker is authoritative for membership. It schedules a cable change after the departing slot's already accepted inputs, using the room generation and a fixed emulated frame. All remaining replicas must apply the same change at that frame, including during rollback. Changing a core option when a WebSocket notification arrives is unsuitable: web and native replicas would unplug at different frames.

Stock RetroArch only carries the ordinary netplay protocol. The proposed transport reserves the unused R3 joypad bit (`0x8000`) for an unplugged GB/GBA console in a versioned room input profile. The broker supplies it in vacant-slot input after the scheduled departure frame. The launcher disables physical R3 bindings in the isolated session configuration, and the web input mapper excludes that binding. The patched core consumes this bit as cable state instead of a game button. The input profile must be explicitly negotiated; old cores must be rejected rather than silently ignoring the bit.

The marker is level-triggered and stays present while a slot is detached. This makes predicted input, rollback replay, late snapshots and the bounded input history describe the same topology. Retaining a room member after closing their game continues to produce ordinary zero input without the unplug marker. A returning room member must first load the current snapshot; cable reconnection is a separate scheduled event. Automatic native admission currently uses a synchronized state barrier; cable topology changes still require separate qualification.

### Required core changes

- **SameBoy:** derive cable connectivity from the two console flags and restore serial callbacks and pending serial state from snapshots. Both ends must be attached for transfers to cross the cable.
- **mGBA Splitscreen:** add a per-console cable mask and detach only that console's SIO driver. Release its coordinator waits and queued transfers while the remaining consoles continue. Keep console/cartridge indices fixed even when cable player IDs change. Serialize the mask, driver identities and coordinator state independently of whether console 0 remains attached. Restoring a snapshot must reconstruct the saved topology before restoring link state.
- **Snes9x:** keep the existing neutral input for an absent controller. Do not interpret the link control bit in SNES rooms.

These changes require a new core version and state/input profile for both WASM and native builds. The launcher and room catalog must deliver matched builds. Current SPST4/SameBoy rollback builds must not be advertised as supporting per-participant cable removal.

### Qualification gate

Use a separate runner with a hard memory limit and at most two CPUs. Do not run emulator rejoin qualification in this WSL workspace. Test two, three and four GBA consoles; departures of the host and every guest; departures during a serial transfer; and rollback across both unplug and reconnect frames. Confirm that snapshots restore identical topology and checksums, remaining games continue, the departed console stops responding to serial traffic, and a forged control flag cannot affect another participant's slot. Include web/web, web/Windows and Windows/Windows cases. Real games may return to their own communication menu when a cable is unplugged; the broker must not restart or close the remaining game sessions to conceal that behavior.

Room retention is implemented and covered by transport and mock-core UI tests. The cable protocol and core work described in this section remain a separate implementation and qualification step.
