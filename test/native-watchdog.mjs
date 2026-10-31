/** Observe native progress only while the test harness itself is responsive. */
export class NativeWatchdog {
  constructor(now = Date.now()) {
    this.lastPoll = now;
    this.lastProgress = now;
    this.lastFrame = 0;
  }

  observe(frame, now = Date.now()) {
    const pollGap = now - this.lastPoll;
    this.lastPoll = now;
    // A paused event loop has not had a chance to process native socket data.
    // Keep this gap in the caller's diagnostics, then begin a fresh observation.
    if (frame !== this.lastFrame || pollGap > 1000) {
      this.lastFrame = frame;
      this.lastProgress = now;
    }
    return { pollGap, stalled: now - this.lastProgress > 5000 };
  }
}
