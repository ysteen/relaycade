import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
    this.salt = room.password ? randomBytes(4).readUInt32BE() || 1 : 0;
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
    socket.on("error", () => this.drop("Native connection failed"));
    socket.on("close", () => {
      clearTimeout(this.timeout);
      room.depart(this, "Native peer disconnected");
    });
  }

  write(bytes) {
    if (this.socket.destroyed) return;
    if (this.socket.writableLength + bytes.length > 20 * 1024 * 1024)
      throw new Error("Native peer is congested");
    this.socket.write(bytes);
  }

  send(command, data) {
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
      const salt = this.salt.toString(16).toUpperCase().padStart(8, "0");
      const expected = Buffer.from(
        createHash("sha256")
          .update(salt + this.room.password)
          .digest("hex")
          .toUpperCase(),
      );
      if (
        !timingSafeEqual(
          Buffer.from(data.toString("ascii").toUpperCase()),
          expected,
        )
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
        if (data.length !== 4 || this.ready || this.room.started)
          throw new Error("Invalid native play request");
        this.ready = true;
        this.room.maybeStart();
        return;
      case CMD.INPUT:
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
        if (frame !== stage + 1)
          throw new Error("Native calibration state is out of order");
        this.calibrationSamples++;
        this.room.sendCalibration(this, stage, state);
        if (stage === 0) {
          this.send(CMD.REQUEST_STATE);
          for (const peer of this.room.peers.values())
            this.send(CMD.INPUT, words(1, peer.player, 0));
        } else {
          this.bootstrapping = false;
          this.bootstrapped = true;
        }
        return;
      }
      case CMD.REQUEST_STATE:
        if (data.length) throw new Error("Invalid state request");
        if (!this.bootstrapping) this.room.requestState(this);
        return;
      case CMD.PING:
        if (data.length) throw new Error("Invalid ping");
        this.send(CMD.PONG);
        return;
      case CMD.ACK:
      case CMD.PONG:
        if (data.length) throw new Error("Unexpected acknowledgement payload");
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

  sync() {
    if (this.phase !== "waiting-state" || !this.room.state) return;
    this.send(
      CMD.SYNC,
      syncPayload(
        this.room.manifest,
        this.player,
        this.nickname,
        this.room.sram,
      ),
    );
    if (this.protocol >= 6) {
      this.send(CMD.ALLOW_PAUSING, words(1));
      this.send(CMD.LATENCY, words(0, 0));
    }
    this.phase = "connected";
  }

  start() {
    this.bootstrapping = true;
    if (this.calibration) this.send(CMD.REQUEST_STATE);
    for (const peer of this.room.peers.values()) {
      if (peer.player === 0) continue;
      this.send(
        CMD.MODE,
        modePayload(0, peer.player, peer.nickname, peer === this, peer.slave),
      );
    }
    for (const peer of this.room.peers.values())
      if (peer !== this || this.slave)
        this.send(CMD.INPUT, words(0, peer.player, 0));
  }

  finishStart() {
    clearTimeout(this.timeout);
    this.sendState(0, this.room.state);
    // Apply the state in a stalled post-frame pass before any new emulation.
    this.send(CMD.STALL, words(1));
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

  sendInput(frame, player, buttons) {
    this.send(CMD.INPUT, words(frame + this.frameOffset, player, buttons));
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

  drop(message) {
    if (this.dropped) return;
    this.dropped = true;
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
    this.socket.destroy();
  }
}
