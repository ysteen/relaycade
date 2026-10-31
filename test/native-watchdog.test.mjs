import assert from "node:assert/strict";
import test from "node:test";
import { NativeWatchdog } from "./native-watchdog.mjs";

test("a responsive harness detects five seconds without native progress", () => {
  const watchdog = new NativeWatchdog(0);
  watchdog.observe(1, 100);
  for (let now = 600; now <= 5100; now += 500)
    assert.equal(watchdog.observe(1, now).stalled, false);
  assert.equal(watchdog.observe(1, 5200).stalled, true);
});

test("a suspended harness gives native socket callbacks a fresh observation window", () => {
  const watchdog = new NativeWatchdog(0);
  watchdog.observe(1, 100);
  assert.deepEqual(watchdog.observe(1, 6545), {
    pollGap: 6445,
    stalled: false,
  });
  for (let now = 7045; now <= 11545; now += 500)
    assert.equal(watchdog.observe(1, now).stalled, false);
  assert.equal(watchdog.observe(1, 11645).stalled, true);
  assert.equal(watchdog.observe(2, 11745).stalled, false);
});
