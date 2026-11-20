# Room membership, game lifetime and cable ownership

The room creator controls game start, seat assignment, player removal and the
disconnect policy. Switching between browser and RetroArch keeps these rights.
If the creator leaves the room, a remaining member takes over. Game state and
clock authority use a separate election that prioritizes a playing RetroArch.

## Disconnect behavior

The host chooses **Keep playing** or **Pause until players rejoin** when creating a room and can change it from the waiting room. New browser-created rooms default to pause; API callers that omit `disconnectPolicy` retain continue behavior. Only a playing participant leaving, disconnecting or closing their game triggers the policy. Idle room members do not pause a game.

Pause mode holds the remaining participants until every absent participant chooses their original slot and joins with the same cartridge and account. The broker synchronizes all active replicas from one checkpoint before resuming. A prior manual pause remains paused. If someone leaves permanently, the host can select Keep playing; the existing cable-detachment and save-ownership rules still apply.

Windows pause mode requires the current registered launcher. The helper translates standard netplay pause/resume packets into local RetroArch commands and suppresses their acknowledgement echoes. It checks `GET_STATUS` before and after a toggle, retries a missed input pulse and reports an unconfirmed state instead of assuming the command succeeded. This avoids the [remote-resume bug in RetroArch 1.22.2](https://github.com/libretro/RetroArch/blob/v1.22.2/network/netplay/netplay_frontend.c#L3854-L3873) without modifying RetroArch or a core. The launcher configures a temporary UDP command port and sends only to localhost. RetroArch binds that command listener on its usual interfaces, so do not expose this port through a router or firewall. Existing helpers can still join continue-mode rooms; pause-mode rooms request a launcher update.

## Implemented room behavior

The following table assumes Keep playing. In pause mode, the remaining participants wait for rejoin instead.

A browser room owns membership. Its WebSocket stays connected while the Windows launcher prepares RetroArch and while RetroArch plays. The broker keeps this room control connection separately from the native gameplay connection, under the same participant and account. Member counts, player numbers and cartridge ownership do not change during the handoff.

| Action                                           | Room membership                   | Local game                           | Other participants |
| ------------------------------------------------ | --------------------------------- | ------------------------------------ | ------------------ |
| Close RetroArch or its launcher connection       | Retained by the open browser room | Closed                               | Keep playing       |
| Cancel or expire Windows preparation             | Return to the same room           | Not started                          | Keep playing       |
| Web **Save and return to room**                  | Retained                          | Save, release core and show room     | Keep playing       |
| **Leave room**, close room page, or host removal | Removed                           | Connection revoked and core released | Keep playing       |

Returning to the room never starts the web core automatically. The player chooses Web browser or Windows RetroArch and selects Join game again. Closing a launcher during a download cannot be detected immediately without a launcher heartbeat; the room stays in preparation until cancellation or expiry. The browser room remains available throughout.

The retained browser responds to room heartbeats even while its native game is active. Closing that browser revokes both a pending native credential and an active native connection. A cancelled or failed native launch returns to the same browser connection. It does not create another member or free the participant's number.

RetroArch may stop processing netplay PING packets during an intentional room pause. The broker suspends native probe deadlines while paused and excludes that interval from RTT samples. Outstanding replies stay ordered before restart barriers; their timeout starts again on resume. Browser room heartbeats and native TCP closure detection remain active, and running native clients still have the normal heartbeat timeout.

Older browser clients can finish their existing sessions. The new page requests `retainRoom=1` when opening its WebSocket. Only these clients receive retained handoff and return messages.

## Continuing a Windows client from the running game

Keep the browser room open, choose Windows RetroArch again, and select **Join game**. A ready native participant with a compatible cartridge and assigned console joins automatically; the host does not press Restart. The broker requests a live full-machine snapshot from a playing RetroArch or web participant and briefly synchronizes the active replicas with the new client. This preserves game progress, ordered cartridges, battery data and link state while rebasing protocol frame numbers. Other idle room members remain idle and unassigned numbers stay unassigned. Web rejoin from another web participant uses a snapshot plus subsequent inputs. A snapshot requested from RetroArch rebases its rollback history, so web admission from a native source uses the same shared state barrier as native admission. Active clients load the exact snapshot and continue with a fresh protocol frame origin; no battery import or game reset occurs.

A snapshot source must remain running. Paused games and busy native state sources defer admission until available. Recovery after every running replica has closed, arbitrary cartridge replacement inside a running snapshot, and all games or player counts are not guaranteed.
The restart barrier drains old inputs through ordered PING/PONG messages. It must not send a forced STALL around the state load: RetroArch 1.22.2 moves to `load_frame - 1` when receiving a future state, expecting its normal post-frame advance. Stalling that advance left the retained native host one emulated frame ahead of the new client and caused the first subsequent CRC check to disconnect it. Startup and ordinary pacing stalls remain separate.

On 2026-11-04, a user-authorized Windows Job Object runner qualified three mGBA Splitscreen cases with the bundled two-cartridge GBA diagnostic fixtures: closing and reopening one native client, and changing a WASM client into a native client while another native host stays connected, and reopening the native host while a web participant keeps playing. Each used exactly one host Start command, for the initial game. All preserved live progress, both cartridge save markers and input-written save counters. Input after rejoining incremented the saved counter again, and native checks at approximately frames 600 and 1200 passed. The mixed tests ran the WASM core and browser protocol in Windows Node, not the browser UI. Each job was limited to 1.5 GiB, two CPU affinity bits and 60 seconds; no emulator ran in WSL. This is a short two-player qualification, not a long-session, all-game or Android qualification.

The prepared Windows assets can be reused with `test/run-windows-continuation.ps1 -Workspace <workspace> -Scenario fresh|rejoin|handoff|web-host`. The wrapper uses `test/windows-bounded.c`'s prebuilt runner and the launcher's real authentication tunnel, creates isolated settings/saves, and writes JSON evidence below `result/netplay-interop/native-continuation-20261104`. Do not run the Node harness directly or move emulator execution back into WSL.

## Selected cartridges and the next game

GB/GBC and GBA rooms collect the cartridge selected on each participant's game page. They have no in-room cartridge picker. Compatible-system cartridges can enter a waiting or running room, including different GB/GBC titles. Names remain visible and the host can remove unwanted participants. Library access rules still apply.

A different cartridge can wait in the room without altering the running set. **Prepare new game**, available to the host once all numbers are assigned, ends the existing game and returns everyone to the same room. Each person selects their client and **Join game** again; the host then selects **Start game** to prepare the new ordered set. Native launch credentials for the old set are revoked. The original account rejoining its own console with the same cartridge needs neither step. Waiting manual-start rooms have no setup deadline; transport health and authentication credential expiry remain bounded.

## Game ownership and save policy

Preparing a game binds each console to its account, network player and cartridge. Closing a client, leaving the room, changing the host or selecting a freed number does not replace that binding. The original account can resume its own console. Another account can stay in the room, but receives no live snapshot, startup SRAM or launcher save bundle from that game, even when it selects the same cartridge and number. The same restriction applies after every client has closed. Anonymous connections have no account identity to recover across disconnects.

The host must prepare a new game to admit a different account or cartridge. That operation discards the previous shared state and native credentials, then prepares a clean core with the current participants' own saves. SNES retains its single shared cartridge save, supplied by the new game's host. Existing RomM native save uploads validate the frozen account, cartridge and player binding in addition to the current generation and confirmed frame; a current seat assignment alone does not grant ownership.

These are admission and save-destination rules, not isolation between authorized participants. Full-state rollback still shares all emulated consoles and their save bytes with the game's legitimate players. No new core or RetroArch protocol is introduced. [Server save synchronization](save-sync.md) uses the same frozen ownership when extracting cartridge saves and writing them to RomM, even after a room closes. Deploy the broker and RomM adapter together: the adapter refuses native save uploads if the broker does not provide ownership metadata.

## Cable disconnection

Cable state follows room membership. Closing RetroArch or selecting **Save and return to room** keeps membership and the cable attached. Explicit room exit, page closure, a confirmed transport failure, preparation expiry without a retained room page, and host removal unplug that participant's console. Other consoles keep their cartridge, save and emulation state. SNES has no link cable and continues to receive neutral input for an absent controller.

The broker schedules unplugging after all accepted input from the departing network player. It supplies the reserved R3 joypad bit (`0x8000`) in that player's subsequent vacant-slot input. This level-triggered marker is recorded in input history, predicted and replayed by ordinary rollback. A participant cannot submit this bit; the browser masks it locally and the Windows launcher's isolated configuration disables physical R3 bindings. No RetroArch application patch or new native packet is required.

The input profile is `link-cable-r3-v1`, selected only for the exact core identities below and announced to web clients. Native handshakes reject different versions. Old rollback cores retain their previous behavior and never receive the marker.

| Core             | Version                | State profile |
| ---------------- | ---------------------- | ------------- |
| SameBoy          | `1.0.4c87d256-cable1`  | SBR3          |
| mGBA Splitscreen | `0.1.0-f1d5975-cable1` | SPST5         |

SameBoy serial and infrared callbacks connect only while both consoles' cable flags are attached. Its snapshot records cable flags and pending serial bits. mGBA removes only the affected console's SIO peripheral, releases waits and invalidates pending transfers that referred to the previous wire IDs. Console/cartridge indices remain fixed while the cable's wire IDs are reassigned. Snapshots restore topology before link-driver state, including when console 0 is unplugged or every cable is detached. These state formats are incompatible with older rollback states; cartridge battery saves keep their existing formats.

A compatible original owner reconnects only after loading a current game snapshot and explicitly joining the game. Their first accepted live input clears the unplug marker at a shared frame. Merely entering the room or selecting a number does not reconnect the cable. Existing ownership and next-game cartridge rules still apply.

## Cable qualification

Commercial ROM lifecycle checks on 2026-11-07 used copies from the user's existing RomM library, with fresh isolated saves. The two Zelda: A Link to the Past & Four Swords variants passed Windows RetroArch/Chrome synchronization, return to room, departure, cable reconnect and live rejoin with one host Start. Ten checks passed before departure and eleven after rejoining. Pokemon Gold and Silver loaded as distinct cartridges in a Windows SameBoy core probe and passed all four cable masks, rollback replay and topology restoration. That SameBoy check did not run through RetroArch or a network session. No Pokemon trade, battle or Four Swords gameplay completion was tested. Existing user saves were not imported or changed. Evidence is stored locally under `result/netplay-interop/commercial-20261107/verification.json`, outside the source repository.

On 2026-11-07, verification resumed after the user requested it. The serial bridge suite passed 112 tests. Windows probes passed every cable mask for SameBoy 2-player and mGBA 2/3/4-player configurations, including rollback and cross-WASM state comparisons. An unmodified Windows RetroArch and isolated Windows Chrome passed the mGBA diagnostic scenario: returning to the room kept both cables attached, full browser departure detached only its cable, explicit rejoin restored it without another host Start, and native host departure left the browser running with only its cable attached. Save markers and progress survived rejoin. This used an isolated broker and a direct WASM page, not a complete RomM/EmulatorJS gameplay session. Deployment checks matched all 108 mounted files, 88 public assets and 16 core downloads. Android and commercial-game link operations remain unqualified. Keep the browser room open for a Windows participant, and update the registered launcher once so its isolated configuration reserves R3.

Use the user-authorized bounded Windows runner or a separate capped Linux runner. Never run these emulators in WSL. `test/run-windows-cable.ps1` tests every cable mask for two, three and four GBA consoles and two Game Boys, including rollback across each change and restoring a detached snapshot from another topology. `-CheckWasm` imports the same Windows reference snapshots into the WASM cores and compares complete states. SameBoy initializes RAM randomly, so comparison begins from the shared native snapshot, as actual netplay does.

`test/run-windows-continuation.ps1 -Workspace <workspace> -Scenario cable-browser` runs an unmodified Windows RetroArch and an isolated real Windows Chrome. It tests return to room, departure, live rejoin and native host departure. The page uses the actual WASM core and browser bridge protocol, without the RomM login or EmulatorJS UI. Each process tree is limited to 1.5 GiB, two CPU affinity bits and 60 seconds. Android execution and commercial-game behavior require separate qualification. A game may display its own cable error or return to its communication menu; the broker does not restart the other games to conceal that behavior.
