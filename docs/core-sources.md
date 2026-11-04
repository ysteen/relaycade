# Published core sources

The source forks below preserve the revisions and patches used by the RomM builds. Build scripts remain in this repository; the RomM adapter distributes the packaged assets and their manifests. Keep the advertised core versions and state profiles unchanged when rebuilding compatible clients.

| Component | Source branch | Scope |
| --- | --- | --- |
| SameBoy | [ysteen/SameBoy: romm/rollback-sbr2](https://github.com/ysteen/SameBoy/tree/romm/rollback-sbr2) | SBR2 state portability, based on `c87d2565` |
| mGBA Splitscreen web | [ysteen/mgba-splitscreen: romm/rollback-spst4-web](https://github.com/ysteen/mgba-splitscreen/tree/romm/rollback-spst4-web) | SPST4 rollback and ordered cartridges, based on `f1d5975d` |
| mGBA Splitscreen native | [ysteen/mgba-splitscreen: romm/rollback-spst4-native](https://github.com/ysteen/mgba-splitscreen/tree/romm/rollback-spst4-native) | Web changes plus native startup, save initialization, player view and platform build support |
| Snes9x | [ysteen/snes9x: romm/rollback-build](https://github.com/ysteen/snes9x/tree/romm/rollback-build) | Unmodified `2d4cce69` core with build provenance |
| DOSBox Pure | [ysteen/dosbox-pure: custom/emulatorjs-persistence](https://github.com/ysteen/dosbox-pure/tree/custom/emulatorjs-persistence) | Persistent disks, content mounting and native/browser write visibility |
| Azahar / 3DS | [ysteen/azahar: romm/web-performance](https://github.com/ysteen/azahar/tree/romm/web-performance) | Web saves, WebGL runtime and interpreter improvements |

The smaller Azahar save-only review branch is [fix/web-savestates](https://github.com/ysteen/azahar/tree/fix/web-savestates). Supporting frontend changes are in [ysteen/RetroArch](https://github.com/ysteen/RetroArch/tree/romm/web-runtime), [ysteen/EmulatorJS](https://github.com/ysteen/EmulatorJS/tree/custom/dosbox-pure-persistence), and [ysteen/build](https://github.com/ysteen/build/tree/custom/dosbox-pure-persistence). The save-focused frontend branches are `fix/azahar-web-savestates` in RetroArch and `fix/azahar-state-runtime` in EmulatorJS.

These are user-owned fork branches. Source publication does not imply upstream acceptance, Android qualification or new performance measurements. Existing verification and its limits are recorded in [native builds](native-builds.md), [room lifecycle](room-lifecycle.md), and the build repository's `AZAHAR_PERFORMANCE.md`. No commercial ROMs, user saves or runtime credentials are included.
