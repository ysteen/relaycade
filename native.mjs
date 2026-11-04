import { randomBytes } from "node:crypto";
import { passwordMatches } from "./native-launch.mjs";
import {
  CMD,
  Decoder,
  MAGIC,
  WASM_PLATFORM,
  fixedString,
  infoPayload,
  modePayload,
  packet,
  readString,
  readStatePayload,
  statePayload,
  syncPayload,
  words,
} from "./wire.mjs";

// Keep a small input lead without letting a faster frontend run away. RetroArch
// accepts at most 60 requested stall frames and spaces server requests by 120
// frames. Also bound wall time so a burst of web progress cannot stack requests.
const PACING_LEAD = 3;
const PACING_TARGET = 2;
const PACING_INTERVAL_FRAMES = 120;
const PACING_INTERVAL_MS = 2000;
const PACING_MAX_STALL = 60;

export class NativePeer {
  constructor(room, socket, player) {
    Object.assign(this, {
      room,
      socket,
      player,
      kind: "native",
      nickname: "RetroArch",
      phase: "header",
      ready: false,
    });
    this.connectedAt = Date.now();
    this.log("native-connected", { remoteAddress: socket.remoteAddress });
    this.nextFrame = 0;
    this.slave = !(room.manifest.maxPrediction > 0);
    this.nextWireFrame = 0;
    this.pendingInputs = [];
    this.nativeInputsReady = false;
    this.calibration = room.manifest.nativeCalibration === "sameboy-v1";
    this.frameOffset = this.calibration ? 2 : 1;
    this.calibrationSamples = 0;
    this.lastReportedFrame = 0;
    this.pendingChecks = new Map();
    this.checksSent = 0;
    this.buttons = 0;
    this.serverFrame = 0;
    this.lobbyFrames = 0;
    this.playing = false;
    this.pacing = null;
    this.salt =
      room.password || room.manifest.nativeAuth
        ? randomBytes(4).readUInt32BE() || 1
        : 0;
    this.decoder = new Decoder(
      (header) => this.header(header),
      (command, data) => this.command(command, data),
    );
    this.timeout = setTimeout(
      () => this.drop("Native handshake timed out"),
      30000,
    );
    this.timeout.unref();
    socket.setNoDelay(true);
    socket.on("data", (bytes) => {
      try {
        this.decoder.push(bytes);
      } catch (error) {
        this.drop(error.message);
      }
    });
    socket.on("error", (error) =>
      this.drop("Native connection failed", { code: error.code }),
    );
    socket.on("close", () => {
      room.pendingNative?.delete(this);
      clearTimeout(this.timeout);
      this.log("native-closed", {
        reason: this.closeReason ?? "Peer closed the connection",
        durationMs: Date.now() - this.connectedAt,
        receivedBytes: socket.bytesRead,
        sentBytes: socket.bytesWritten,
        ready: this.ready,
        playing: this.playing,
        lobbyFrames: this.lobbyFrames,
        serverFrame: this.serverFrame,
        lastReportedFrame: this.lastReportedFrame,
      });
      room.depart(this, "Native peer disconnected");
    });
  }

  log(event, fields = {}) {
    this.room.bridge?.log(event, {
      room: this.room.id,
      port: this.room.tcpPort,
      player: this.player,
      phase: this.phase,
      ...fields,
    });
  }

  write(bytes) {
    if (this.socket.destroyed) return;
    if (this.socket.writableLength + bytes.length > 20 * 1024 * 1024)
      throw new Error("Native peer is congested");
    this.socket.write(bytes);
  }

  send(command, data) {
    if (command === CMD.INPUT && data.readUInt32BE(4) === 0)
      this.serverFrame = data.readUInt32BE(0) + 1;
    if (command === CMD.NOINPUT) this.serverFrame = data.readUInt32BE(0) + 1;
    this.write(packet(command, data));
  }

  header(bytes) {
    if (bytes.readUInt32BE(0) !== MAGIC)
      throw new Error("Invalid RetroArch handshake");
    const low = bytes.readUInt32BE(16);
    const high = bytes.readUInt32BE(12) || low;
    this.protocol = Math.min(high, 7);
    if (low > 7 || this.protocol < 5 || this.protocol < low)
      throw new Error("Unsupported RetroArch protocol");
    this.compressed = !!(bytes.readUInt32BE(8) & 1);
    this.log("native-protocol", {
      protocol: this.protocol,
      compressed: this.compressed,
    });
    this.write(
      words(
        MAGIC,
        WASM_PLATFORM,
        this.compressed ? 1 : 0,
        this.salt,
        this.protocol,
        0,
      ),
    );
    this.phase = "nick";
  }

  command(command, data) {
    if (this.phase === "nick") {
      if (command !== CMD.NICK || data.length !== 32)
        throw new Error("Expected RetroArch nickname");
      this.nickname = readString(data) || "RetroArch";
      this.send(CMD.NICK, fixedString(this.room.manifest.nickname));
      this.phase = this.salt ? "password" : "info";
      if (!this.salt) this.send(CMD.INFO, infoPayload(this.room.manifest));
      return;
    }
    if (this.phase === "password") {
      if (command !== CMD.PASSWORD || data.length !== 64)
        throw new Error("Expected RetroArch password");
      if (
        !(this.room.manifest.nativeAuth
          ? this.room.admitNative(this, data)
          : passwordMatches(this.salt, this.room.password, data))
      )
        throw new Error("Incorrect room password");
      this.send(CMD.INFO, infoPayload(this.room.manifest));
      this.phase = "info";
      return;
    }
    if (this.phase === "info") {
      if (command !== CMD.INFO || data.length !== 68)
        throw new Error("Expected RetroArch core information");
      const name = readString(data.subarray(4, 36));
      const version = readString(data.subarray(36, 68));
      const crc = data.readUInt32BE(0);
      const expected = this.room.manifest;
      this.log("native-core-info", {
        coreName: name,
        coreVersion: version,
        contentCrc: crc,
        expectedCoreName: expected.coreName,
        expectedCoreVersion: expected.coreVersion,
        expectedContentCrc: expected.contentCrc,
      });
      if (
        name.toLowerCase() !== expected.coreName.toLowerCase() ||
        version !== expected.coreVersion
      )
        throw new Error("Core name or version does not match the web build");
      if (crc !== expected.contentCrc)
        throw new Error("Content CRC does not match");
      this.phase = "waiting-state";
      this.sync();
      return;
    }
    if (this.phase === "waiting-state")
      throw new Error("Native handshake is waiting for the web host state");
    switch (command) {
      case CMD.PLAY:
        if (
          data.length !== 4 ||
          this.ready ||
          (this.room.started && !this.room.manifest.manualStart)
        )
          throw new Error("Invalid native play request");
        this.ready = true;
        this.log("native-ready");
        if (this.room.manifest.manualStart) clearTimeout(this.timeout);
        this.keepLobbyAlive();
        this.room.lobby();
        this.room.maybeStart();
        this.room.resumeGame?.(this);
        return;
      case CMD.INPUT:
        if (this.restarting) {
          if (data.length !== 12) throw new Error("Invalid native input");
          this.lastReportedFrame = Math.max(
            this.lastReportedFrame,
            data.readUInt32BE(0),
          );
          return;
        }
        if (!this.room.started || data.length !== 12)
          throw new Error("Unexpected native input");
        if (!this.slave) {
          this.receiveInput(data);
          return;
        }
        this.lastReportedFrame = Math.max(
          this.lastReportedFrame,
          data.readUInt32BE(0),
        );
        this.flushChecks();
        this.buttons = data.readUInt32BE(8);
        if (
          this.bootstrapping &&
          !this.calibration &&
          data.readUInt32BE(0) >= this.frameOffset
        ) {
          this.bootstrapping = false;
          this.bootstrapped = true;
          this.room.finishStart();
        }
        if (this.buttons > 65535)
          throw new Error("Invalid native joypad input");
        return;
      case CMD.LOAD_STATE: {
        if (this.checkpointRequested) {
          this.checkpointRequested = false;
          clearTimeout(this.checkpointTimeout);
          const { frame, state } = readStatePayload(
            data,
            this.protocol,
            this.compressed,
            this.room.manifest.stateSize,
          );
          this.room.nativeCheckpoint(this, frame - this.frameOffset, state);
          return;
        }
        if (this.resumeSourceId) {
          const id = this.resumeSourceId;
          this.resumeSourceId = null;
          const { frame, state } = readStatePayload(
            data,
            this.protocol,
            this.compressed,
            this.room.manifest.stateSize,
          );
          this.room.completeResume(this, id, frame - this.frameOffset, state);
          return;
        }
        if (this.restartSourceRequested) {
          const { state } = readStatePayload(
            data,
            this.protocol,
            this.compressed,
            this.room.manifest.stateSize === 1 &&
              this.room.manifest.nativeAuthority
              ? undefined
              : this.room.manifest.stateSize,
          );
          this.restartSourceRequested = false;
          clearTimeout(this.sourceTimeout);
          if (this.room.starting) this.room.prepareGame(state);
          return;
        }
        if (
          !this.calibration ||
          !this.bootstrapping ||
          this.calibrationSamples >= 2
        )
          throw new Error("Unsolicited native state");
        const { frame, state } = readStatePayload(
          data,
          this.protocol,
          this.compressed,
          this.room.manifest.stateSize,
        );
        const stage = this.calibrationSamples;
        if (frame !== this.startFrame + stage + 1)
          throw new Error("Native calibration state is out of order");
        this.calibrationSamples++;
        this.room.sendCalibration(this, stage, state);
        if (stage === 0) {
          this.send(CMD.REQUEST_STATE);
          for (const peer of this.room.peers.values())
            this.send(
              CMD.INPUT,
              words(this.startFrame + 1, this.wirePlayer(peer.player), 0),
            );
        } else {
          this.bootstrapping = false;
          this.bootstrapped = true;
        }
        return;
      }
      case CMD.REQUEST_STATE:
        if (data.length) throw new Error("Invalid state request");
        if (this.room.manifest.nativeAuthority && !this.playing) return;
        if (!this.bootstrapping) this.room.requestState(this);
        return;
      case CMD.PING:
        if (data.length) throw new Error("Invalid ping");
        this.send(CMD.PONG);
        return;
      case CMD.ACK:
        if (data.length) throw new Error("Unexpected acknowledgement payload");
        return;
      case CMD.PONG:
        if (data.length) throw new Error("Unexpected acknowledgement payload");
        this.room.pong?.(this);
        if (this.restarting && --this.restartPongs === 0) {
          this.restartReady = true;
          this.room.maybeStart();
        }
        return;
      case CMD.PAUSE:
        if (data.length !== 32) throw new Error("Invalid pause");
        this.room.pause(this, true);
        return;
      case CMD.RESUME:
        if (data.length) throw new Error("Invalid resume");
        this.room.pause(this, false);
        return;
      case CMD.DISCONNECT:
        this.close();
        return;
      case CMD.NAK:
        throw new Error("RetroArch rejected the protocol exchange");
      case CMD.SPECTATE:
      case CMD.RESET:
        throw new Error(
          "Spectator and reset commands are not supported in a linked session",
        );
      default:
        throw new Error(`Unsupported native command ${command.toString(16)}`);
    }
  }

  wirePlayer(player) {
    if (this.player !== 0 || !this.serverPlayer) return player;
    if (player === 0) return this.serverPlayer;
    return player === this.serverPlayer ? 0 : player;
  }

  sync() {
    if (
      this.phase !== "waiting-state" ||
      (!this.room.state && !this.room.manifest.nativeAuthority)
    )
      return;
    // RetroArch reserves wire client zero for the server, independently of room membership.
    this.serverPlayer = this.player === 0 ? 1 : 0;
    this.send(
      CMD.SYNC,
      syncPayload(
        this.room.manifest,
        this.wirePlayer(this.player),
        this.nickname,
        this.room.manifest.nativeAuthority && !this.room.hadGame
          ? Buffer.alloc(0)
          : this.room.sram,
        this.room.seats[this.serverPlayer] ?? 0,
      ),
    );
    if (this.protocol >= 6) {
      this.send(CMD.ALLOW_PAUSING, words(1));
      this.send(CMD.LATENCY, words(0, 0));
    }
    this.phase = "connected";
    this.log("native-synced", { sramBytes: this.room.sram.length });
  }

  keepLobbyAlive() {
    if (
      !this.room.manifest.manualStart ||
      this.phase !== "connected" ||
      !this.ready ||
      this.playing ||
      this.bootstrapping
    )
      return;
    // RetroArch spectators time out after ten seconds without input frames.
    this.send(CMD.INPUT, words(this.serverFrame, 0, 0));
    this.lobbyFrames++;
  }

  start() {
    if (this.restarting) {
      this.bootstrapped = true;
      return;
    }
    this.bootstrapping = true;
    this.startFrame = this.serverFrame;
    this.frameOffset = this.startFrame + (this.calibration ? 2 : 1);
    this.nextWireFrame = this.startFrame;
    this.wireSeats = this.room.seats.slice();
    this.log("native-start", {
      wireFrame: this.startFrame,
      frameOffset: this.frameOffset,
      lobbyFrames: this.lobbyFrames,
    });
    if (this.room.manifest.manualStart) {
      this.timeout = setTimeout(
        () => this.drop("Native startup timed out"),
        30000,
      );
      this.timeout.unref();
    }
    if (this.calibration) this.send(CMD.REQUEST_STATE);
    for (const peer of this.room.peers.values()) {
      if (peer.player === 0 && !this.room.manifest.manualStart) continue;
      this.send(
        CMD.MODE,
        modePayload(
          this.startFrame,
          this.wirePlayer(peer.player),
          peer.nickname,
          peer === this,
          peer.slave,
          (this.room.gameSeats ?? this.room.seats)[peer.player],
        ),
      );
    }
    for (const peer of this.room.peers.values())
      if (peer !== this || this.slave)
        this.send(
          CMD.INPUT,
          words(this.startFrame, this.wirePlayer(peer.player), 0),
        );
  }

  finishStart() {
    clearTimeout(this.timeout);
    this.pacing = null;
    if (this.restarting) {
      this.finishRestart();
      return;
    }
    this.sendState(0, this.room.state);
    // Apply the state in a stalled post-frame pass before any new emulation.
    this.send(CMD.STALL, words(1));
  }

  requestRestartSource() {
    if (this.checkpointRequested || this.resumeSourceId)
      throw new Error("The host is synchronizing. Try starting again shortly.");
    if (this.restartSourceRequested) return;
    this.restartSourceRequested = true;
    this.send(CMD.REQUEST_STATE);
    if (!this.playing) {
      this.keepLobbyAlive();
      this.keepLobbyAlive();
    }
    this.sourceTimeout = setTimeout(() => {
      this.restartSourceRequested = false;
      this.room.starting = false;
      this.room.notify({
        t: "action-error",
        message: "Could not read the current game state. Try restarting again.",
      });
      this.room.lobby();
    }, 10000);
    this.sourceTimeout.unref();
  }

  requestResumeSource(id) {
    this.resumeSourceId = id;
    this.send(CMD.REQUEST_STATE);
  }

  requestCheckpoint() {
    if (
      this.checkpointRequested ||
      this.restartSourceRequested ||
      this.resumeSourceId
    )
      return;
    this.checkpointRequested = true;
    this.send(CMD.REQUEST_STATE);
    this.checkpointTimeout = setTimeout(() => {
      this.log("native-checkpoint-timeout");
    }, 10000);
    this.checkpointTimeout.unref();
  }

  prepareRestart() {
    this.restarting = true;
    this.restartReady = false;
    this.restartPongs = this.probe ? 2 : 1;
    this.nativeInputsReady = false;
    this.pendingInputs.length = 0;
    this.pendingChecks.clear();
    // Drain old input through an ordered PING/PONG barrier. Do not stall:
    // loading a future state puts RetroArch at load_frame - 1 and relies on
    // its post-frame advance. A stall skips that advance and resumes the
    // existing peer one emulated frame ahead of newly connected clients.
    this.send(CMD.PING);
    this.timeout = setTimeout(
      () => this.drop("Native restart timed out"),
      15000,
    );
    this.timeout.unref();
  }

  finishRestart() {
    const base = Math.max(this.serverFrame, this.lastReportedFrame + 1);
    for (let frame = this.serverFrame; frame < base; frame++)
      this.send(CMD.NOINPUT, words(frame));
    for (let player = 0; player < this.room.manifest.players; player++) {
      const seat = (this.room.gameSeats ?? this.room.seats)[player];
      if (player === this.player || this.wireSeats[player] === seat) continue;
      const nickname = this.room.peers.get(player)?.nickname ?? "Empty";
      const wirePlayer = this.wirePlayer(player);
      const removed = modePayload(
        base,
        wirePlayer,
        nickname,
        false,
        false,
        seat,
      );
      removed.writeUInt32BE(wirePlayer, 4);
      removed.writeUInt32BE(0, 8);
      this.send(CMD.MODE, removed);
      this.send(
        CMD.MODE,
        modePayload(base, wirePlayer, nickname, false, false, seat),
      );
    }
    this.wireSeats = this.room.seats.slice();
    this.frameOffset = base;
    this.nextWireFrame = base;
    this.nextFrame = 0;
    this.restarting = false;
    this.sendState(0, this.room.state);
  }

  receiveInput(data) {
    const wireFrame = data.readUInt32BE(0);
    const buttons = data.readUInt32BE(8);
    if (buttons > 65535) throw new Error("Invalid native joypad input");
    // The socket owns the slot; the claimed player number is not authority.
    if (wireFrame < this.nextWireFrame) return;
    if (wireFrame !== this.nextWireFrame)
      throw new Error("Native input frames must be sequential");
    this.nextWireFrame++;
    this.lastReportedFrame = wireFrame;
    this.flushChecks();
    if (wireFrame < this.frameOffset) return;
    const frame = wireFrame - this.frameOffset;
    if (this.nativeInputsReady) this.room.input(this, frame, buttons);
    else {
      if (this.pendingInputs.length >= 120)
        throw new Error("Native startup input queue exceeded");
      this.pendingInputs.push([frame, buttons]);
    }
    if (this.bootstrapping) {
      this.bootstrapping = false;
      this.bootstrapped = true;
      this.room.finishStart();
    }
  }

  flushInputs() {
    if (this.slave || !this.room.running) return;
    this.nativeInputsReady = true;
    for (const [frame, buttons] of this.pendingInputs)
      this.room.input(this, frame, buttons);
    this.pendingInputs.length = 0;
  }

  pace(host, now = performance.now()) {
    if (
      !this.room.running ||
      this.room.paused ||
      this.slave ||
      !this.playing ||
      !this.nativeInputsReady ||
      this.bootstrapping ||
      this.restarting ||
      this.phase !== "connected" ||
      this.socket.destroyed ||
      (host?.kind !== "web" &&
        !(this.room.manifest.nativeAuthority && host?.kind === "native")) ||
      host === this ||
      !host.playing ||
      host.player !== this.room.host ||
      this.room.peers.get(host.player) !== host
    ) {
      this.pacing = null;
      return;
    }
    if (this.pacing?.host !== host || host.frame < this.pacing.frame) {
      // Allow startup or a new host to settle before making a correction.
      this.pacing = { host, frame: host.frame, at: now };
      return;
    }
    const lead = this.nextFrame - host.frame;
    if (
      lead <= PACING_LEAD ||
      host.frame - this.pacing.frame < PACING_INTERVAL_FRAMES ||
      now - this.pacing.at < PACING_INTERVAL_MS
    )
      return;
    const frames = Math.min(PACING_MAX_STALL, lead - PACING_TARGET);
    this.pacing.frame = host.frame;
    this.pacing.at = now;
    // Pause execution, not the input stream: frame offsets and state/checksum
    // identities must remain unchanged throughout the current game.
    this.send(CMD.STALL, words(frames));
    this.log("native-paced", {
      hostPlayer: host.player,
      hostFrame: host.frame,
      nativeFrame: this.nextFrame,
      leadFrames: lead,
      stallFrames: frames,
    });
  }

  sendInput(frame, player, buttons) {
    this.send(
      CMD.INPUT,
      words(frame + this.frameOffset, this.wirePlayer(player), buttons),
    );
  }

  sendCrc(frame, crc) {
    this.pendingChecks.set(frame + this.frameOffset, crc);
    if (this.pendingChecks.size > 16)
      throw new Error("Native peer fell behind the verification window");
    this.flushChecks();
  }

  flushChecks() {
    // RetroArch discards checksums for frames it has not serialized yet. Its
    // outgoing input frame is captured after that frame's pre-frame snapshot.
    for (const [frame, crc] of this.pendingChecks) {
      if (frame > this.lastReportedFrame) continue;
      this.send(CMD.CRC, words(frame, crc));
      this.pendingChecks.delete(frame);
      this.checksSent++;
    }
  }

  sendState(frame, state) {
    this.send(
      CMD.LOAD_STATE,
      statePayload(
        frame + this.frameOffset,
        state,
        this.protocol,
        this.compressed,
      ),
    );
  }

  drop(message, details = {}) {
    if (this.dropped) return;
    this.dropped = true;
    this.closeReason = message;
    this.log("native-error", { reason: message, ...details });
    this.room.notify({ t: "peer-error", player: this.player, message });
    try {
      this.send(CMD.NAK);
    } catch {
      /* Socket is already unavailable. */
    }
    this.close();
  }

  close() {
    clearTimeout(this.timeout);
    clearTimeout(this.sourceTimeout);
    clearTimeout(this.checkpointTimeout);
    this.socket.destroy();
  }
}
