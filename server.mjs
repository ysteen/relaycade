import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { NativePeer } from "./native.mjs";
import { CMD, MAX_STATE, fixedString, words } from "./wire.mjs";

const MAX_JSON = 512 * 1024;
const MAX_QUEUE = 20 * 1024 * 1024;
const TOKEN_LIFETIME = 60000;
const uint = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
const token = () => randomBytes(24).toString("base64url");
function secretEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function boundedString(value, fallback, max) {
  if (value === undefined) return fallback;
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > max ||
    value.includes("\0")
  )
    throw new Error("Invalid text field");
  return value;
}
function validateManifest(body) {
  if (!body || !["gb", "gba", "snes"].includes(body.system))
    throw new Error("Unsupported system");
  if (
    !Number.isInteger(body.players) ||
    body.players < 2 ||
    body.players > (body.system === "gba" ? 4 : 2)
  )
    throw new Error("Invalid player count");
  if (
    !Number.isInteger(body.stateSize) ||
    body.stateSize < 1 ||
    body.stateSize > MAX_STATE
  )
    throw new Error("Invalid state size");
  if (!uint(body.contentCrc)) throw new Error("Invalid content CRC");
  const coreName = boundedString(body.coreName, "", 31);
  const coreVersion = boundedString(body.coreVersion, "", 31);
  if (!coreName || !coreVersion) throw new Error("Core identity is required");
  const maxPrediction = body.maxPrediction ?? 0;
  if (
    !Number.isInteger(maxPrediction) ||
    maxPrediction < 0 ||
    maxPrediction > 30
  )
    throw new Error("Invalid prediction window");
  if (maxPrediction && body.nativeCalibration)
    throw new Error("Startup calibration does not qualify a core for rollback");
  if (
    body.nativeAllowed !== undefined &&
    typeof body.nativeAllowed !== "boolean"
  )
    throw new Error("Invalid nativeAllowed flag");
  if (
    body.nativeCalibration !== undefined &&
    body.nativeCalibration !== "sameboy-v1"
  )
    throw new Error("Unsupported native calibration");
  if (
    body.nativeCalibration &&
    (!body.nativeAllowed ||
      body.system !== "gb" ||
      coreName !== "SameBoy" ||
      coreVersion !== "1.0.4 c87d256")
  )
    throw new Error(
      "Native calibration requires the qualified two-player SameBoy profile",
    );
  const owner = boundedString(body.owner, "", 128);
  if (body.manualStart !== undefined && typeof body.manualStart !== "boolean")
    throw new Error("Invalid manualStart flag");
  if (
    body.romId !== undefined &&
    (!Number.isSafeInteger(body.romId) || body.romId < 1)
  )
    throw new Error("Invalid ROM identifier");
  return {
    system: body.system,
    players: body.players,
    stateSize: body.stateSize,
    contentCrc: body.contentCrc,
    coreName,
    coreVersion,
    maxPrediction,
    owner,
    romId: body.romId ?? null,
    nativeAllowed: body.nativeAllowed ?? false,
    manualStart: body.manualStart ?? false,
    nativeCalibration: body.nativeCalibration,
    nickname: boundedString(body.nickname, "RomM", 31),
  };
}

function jsonPeer(peer, value) {
  if (peer?.kind !== "web" || peer.ws.readyState !== WebSocket.OPEN) return;
  const bytes = JSON.stringify(value);
  if (peer.ws.bufferedAmount + Buffer.byteLength(bytes) > MAX_QUEUE)
    throw new Error("Web peer is congested");
  peer.ws.send(bytes);
}
function binaryPeer(peer, bytes) {
  if (peer.ws.bufferedAmount + bytes.length > MAX_QUEUE)
    throw new Error("Web peer is congested");
  peer.ws.send(bytes, { binary: true });
}

class Room {
  constructor(bridge, manifest, password) {
    Object.assign(this, {
      bridge,
      manifest,
      password,
      id: token(),
      peers: new Map(),
      reservations: new Map(),
      pendingBatteries: new Set(),
    });
    this.state = null;
    this.sram = Buffer.alloc(0);
    this.revision = 0;
    this.started = false;
    this.starting = false;
    this.seats = Array.from({ length: manifest.players }, (_, player) =>
      manifest.manualStart ? null : player,
    );
    this.closed = false;
    this.nextHostFrame = 0;
    this.progress = 0;
    this.confirmed = 0;
    this.heldInputs = [];
    this.crcs = new Map();
    this.latestCheckpoint = 0;
    this.resyncs = [];
    this.host = 0;
    this.generation = 0;
    this.vacant = new Map();
    this.paused = false;
    if (manifest.manualStart) {
      this.heartbeat = setInterval(() => this.probePeers(), 2000);
      this.heartbeat.unref();
      this.nativeClock = setInterval(() => this.tickNativeClock(), 8);
      this.nativeClock.unref();
    }
    this.timer = setTimeout(
      () => this.close("Room setup timed out"),
      (manifest.manualStart ? 30 : 5) * 60000,
    );
    this.timer.unref();
  }

  metadata() {
    this.expireReservations();
    const {
      owner,
      romId,
      system,
      coreName,
      coreVersion,
      contentCrc,
      nativeAllowed,
      nativeCalibration,
      maxPrediction,
      players,
      stateSize,
    } = this.manifest;
    return {
      id: this.id,
      owner,
      romId,
      system,
      coreName,
      coreVersion,
      contentCrc,
      nativeAllowed,
      nativeCalibration,
      maxPrediction,
      players,
      stateSize,
      current: this.peers.size + this.reservations.size,
      started: this.started || this.starting,
      tcpPort: this.tcpPort ?? null,
      hasPassword: !!this.password,
    };
  }

  reserve(player, owner, nickname) {
    const credential = token();
    this.reservations.set(player, {
      credential,
      owner,
      nickname,
      until: Date.now() + TOKEN_LIFETIME,
    });
    return credential;
  }

  expireReservations() {
    for (const [slot, reservation] of this.reservations) {
      if (reservation.until < Date.now()) this.reservations.delete(slot);
    }
  }

  available(native = false) {
    this.expireReservations();
    for (
      let slot =
        !native && this.manifest.manualStart && !this.peers.has(0) ? 0 : 1;
      slot < this.manifest.players;
      slot++
    )
      if (!this.peers.has(slot) && !this.reservations.has(slot)) return slot;
    return -1;
  }

  canStart() {
    return (
      !!this.state &&
      (!this.started ||
        [...this.peers.values()].some((peer) => !peer.playing)) &&
      !this.starting &&
      (this.hadGame || this.peers.size === this.manifest.players) &&
      [...this.peers.keys()].every((player) => this.seats[player] !== null) &&
      [...this.peers.values()].every(
        (peer) => peer.kind === "web" || peer.ready,
      )
    );
  }

  lobby() {
    if (!this.manifest.manualStart || this.closed) return;
    this.notify({
      t: "lobby",
      players: this.manifest.players,
      seats: this.seats,
      host: this.host,
      running: !!this.running,
      starting: this.starting,
      canStart: this.canStart(),
      members: [...this.peers.values()].map((peer) => ({
        player: peer.player,
        nickname: peer.nickname,
        kind: peer.kind,
        ready: peer.kind === "web" || peer.ready,
        playing: !!peer.playing,
        ping: peer.ping ?? null,
      })),
    });
  }

  control(peer, data) {
    const reject = (message) => jsonPeer(peer, { t: "action-error", message });
    if (!this.manifest.manualStart)
      return reject("This room does not have a lobby");
    if (this.starting) return reject("The game is already starting");
    if (data.t === "assign") {
      if (peer.player !== this.host && data.player !== peer.player)
        return reject("You can only change your own player number");
      if (
        !Number.isInteger(data.player) ||
        !this.peers.has(data.player) ||
        (data.seat !== null &&
          (!Number.isInteger(data.seat) ||
            data.seat < 0 ||
            data.seat >= this.manifest.players))
      )
        return reject("Choose a connected player and a valid player number");
      if (this.running && this.peers.get(data.player).playing)
        return reject("Player numbers are fixed until the next game");
      const other = this.seats.indexOf(data.seat);
      if (data.seat !== null && other !== -1 && other !== data.player)
        return reject("That player number is already selected");
      this.seats[data.player] = data.seat;
      this.lobby();
      return;
    }
    if (peer.player !== this.host)
      return reject("Only the host can start the game");
    if (!this.canStart())
      return reject(
        "Wait for every player to connect and choose a player number",
      );
    this.starting = true;
    if (this.running && !peer.playing) {
      const source = [...this.peers.values()].find(
        (other) => other.kind === "native" && other.playing,
      );
      if (source) {
        source.requestRestartSource();
        this.lobby();
        return;
      }
    }
    this.prepareGame();
  }

  prepareGame(source) {
    const restarting = this.started;
    const used = new Set(this.seats.filter((seat) => seat !== null));
    for (let player = 0; player < this.manifest.players; player++) {
      if (this.seats[player] !== null) continue;
      const seat = Array.from(
        { length: this.manifest.players },
        (_, index) => index,
      ).find((value) => !used.has(value));
      this.seats[player] = seat;
      used.add(seat);
    }
    this.generation++;
    this.started = false;
    this.running = false;
    this.paused = false;
    this.requestedFrame = undefined;
    this.heldInputs.length = 0;
    this.pendingBatteries.clear();
    this.crcs.clear();
    this.latestCheckpoint = 0;
    this.resyncs.length = 0;
    this.progress = this.confirmed = this.nextHostFrame = 0;
    this.vacant = new Map(
      Array.from({ length: this.manifest.players }, (_, player) => player)
        .filter((player) => !this.peers.has(player))
        .map((player) => [player, 0]),
    );
    if (source) {
      const host = this.peers.get(this.host);
      jsonPeer(host, { t: "restart-source", size: source.length });
      binaryPeer(host, source);
    }
    for (const other of this.peers.values()) {
      other.nextFrame = other.frame = other.confirmed = 0;
      other.lastCheckpoint = 0;
      if (other.kind === "web") {
        other.ready = -1;
        other.battery = other.player === this.host;
        if (other.player !== this.host) this.pendingBatteries.add(other.player);
      } else if (other.playing) other.prepareRestart();
    }
    this.lobby();
    for (const other of this.peers.values())
      jsonPeer(other, {
        t: "prepare",
        seats: this.seats,
        host: this.host,
        generation: this.generation,
        restarting,
      });
  }

  attach(ws, slot, reservation) {
    this.reservations.delete(slot);
    const peer = {
      kind: "web",
      player: slot,
      nickname: reservation.nickname,
      owner: reservation.owner,
      ws,
      nextFrame: 0,
      ready: -1,
      battery: slot === 0,
      transfer: null,
      frame: 0,
      confirmed: 0,
      playing: false,
    };
    this.peers.set(slot, peer);
    if (this.manifest.manualStart) {
      this.seats[slot] = null;
      this.electHost();
    }
    jsonPeer(peer, {
      t: "joined",
      player: slot,
      players: this.manifest.players,
      ...(this.manifest.manualStart
        ? {
            manualStart: true,
            host: this.host,
            generation: this.generation,
            running: !!this.running,
          }
        : {}),
    });
    ws.on("message", (bytes, binary) => {
      try {
        if (binary) this.binary(peer, bytes);
        else {
          if (bytes.length > MAX_JSON)
            throw new Error("Web message is too large");
          if (peer.transfer) throw new Error("Expected binary transfer");
          this.message(peer, JSON.parse(bytes.toString()));
        }
      } catch (error) {
        this.close(error.message);
      }
    });
    ws.on("error", () => this.depart(peer, "Web connection failed"));
    ws.on("close", () => this.depart(peer, "Web peer disconnected"));
    if (slot && this.state && !this.manifest.manualStart)
      this.sendWebState(peer, 0);
    this.lobby();
  }

  message(peer, data) {
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error("Invalid web message");
    if (data.t === "pong") {
      this.pong(peer, data.nonce);
      return;
    }
    if (
      this.manifest.manualStart &&
      (data.generation ?? 0) !== this.generation
    ) {
      if ((data.generation ?? 0) < this.generation) {
        if (data.t === "state" || data.t === "battery")
          peer.transfer = { ...data, discard: true };
        return;
      }
      throw new Error("Invalid room generation");
    }
    switch (data.t) {
      case "assign":
      case "start-request":
        this.control(peer, data);
        return;
      case "state":
        if (
          peer.player !== this.host ||
          !uint(data.f) ||
          data.size !== this.manifest.stateSize
        )
          throw new Error("Invalid host state");
        if (this.started ? data.f !== this.requestedFrame : data.f !== 0)
          throw new Error("Unexpected state frame");
        if (
          data.sram !== undefined &&
          (typeof data.sram !== "string" ||
            data.sram.length > 180000 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
              data.sram,
            ))
        )
          throw new Error("Invalid SRAM");
        if (
          data.batteryPlayer !== undefined &&
          !this.pendingBatteries.has(data.batteryPlayer)
        )
          throw new Error("Unknown battery acknowledgement");
        peer.transfer = { ...data };
        return;
      case "battery":
        if (
          peer.player === this.host ||
          this.started ||
          (this.manifest.manualStart && !this.starting) ||
          peer.battery ||
          !uint(data.size) ||
          data.size > 131072
        )
          throw new Error("Invalid guest battery");
        if (this.manifest.system === "snes" && data.size !== 0)
          throw new Error("SNES uses the host's shared cartridge save");
        peer.transfer = { ...data };
        return;
      case "ready":
        if (
          !uint(data.revision) ||
          data.revision > this.revision ||
          !this.state
        )
          throw new Error("Invalid state acknowledgement");
        if (data.revision < this.revision) return;
        peer.ready = data.revision;
        this.maybeStart();
        return;
      case "native-ready": {
        const native = [...this.peers.values()].find(
          (other) => other.kind === "native",
        );
        if (
          peer.player !== this.host ||
          !this.started ||
          this.running ||
          !native?.calibration ||
          !native.bootstrapped ||
          native.calibrated
        )
          throw new Error("Unexpected native calibration acknowledgement");
        native.calibrated = true;
        this.finishStart();
        return;
      }
      case "input":
        if (this.manifest.manualStart && !peer.playing) return;
        this.input(peer, data.f, data.b);
        return;
      case "progress":
        if (this.manifest.manualStart && !peer.playing) return;
        if (
          !this.running ||
          !uint(data.f) ||
          !uint(data.confirmed) ||
          data.confirmed > data.f ||
          data.confirmed < peer.confirmed ||
          (this.manifest.maxPrediction > 0 &&
            (data.f - data.confirmed > this.manifest.maxPrediction ||
              [...this.peers.values()].some(
                (other) =>
                  (!this.manifest.manualStart || other.playing) &&
                  data.confirmed > other.nextFrame,
              ))) ||
          data.f < peer.frame ||
          data.f > peer.nextFrame + 30
        )
          throw new Error("Invalid frame progress");
        peer.frame = data.f;
        peer.confirmed = data.confirmed;
        if (peer.player === this.host) {
          this.progress = data.f;
          this.confirmed = data.confirmed;
        }
        return;
      case "crc":
        if (this.manifest.manualStart && !peer.playing) return;
        this.checksum(peer, data);
        return;
      case "pause":
        if (this.manifest.manualStart && !peer.playing) return;
        if (typeof data.paused !== "boolean") throw new Error("Invalid pause");
        this.pause(peer, data.paused);
        return;
      default:
        throw new Error("Unknown web message");
    }
  }

  binary(peer, bytes) {
    const transfer = peer.transfer;
    peer.transfer = null;
    if (!transfer || bytes.length !== transfer.size)
      throw new Error("Invalid binary transfer size");
    if (
      transfer.discard ||
      (this.manifest.manualStart &&
        (transfer.generation ?? 0) !== this.generation)
    )
      return;
    if (transfer.t === "battery") {
      const host = this.peers.get(this.host);
      if (!host) throw new Error("Host is not connected");
      peer.battery = true;
      this.pendingBatteries.add(peer.player);
      host.ready = -1;
      jsonPeer(host, { t: "battery", player: peer.player, size: bytes.length });
      binaryPeer(host, bytes);
      return;
    }
    this.state = Buffer.from(bytes);
    if (transfer.sram !== undefined)
      this.sram = Buffer.from(transfer.sram, "base64");
    if (transfer.batteryPlayer !== undefined)
      this.pendingBatteries.delete(transfer.batteryPlayer);
    this.revision++;
    if (this.started) {
      for (const other of this.peers.values()) {
        if (other.kind === "native") other.sendState(transfer.f, this.state);
      }
      this.requestedFrame = undefined;
      for (const input of this.heldInputs) this.relayInput(...input);
      this.heldInputs.length = 0;
    } else {
      for (const other of this.peers.values()) {
        if (other.kind === "native") other.sync();
        if (
          other !== peer &&
          other.kind === "web" &&
          (!this.manifest.manualStart || this.starting)
        ) {
          other.ready = -1;
          this.sendWebState(other, 0);
        }
      }
    }
    jsonPeer(peer, {
      t: "state-ready",
      revision: this.revision,
      f: transfer.f,
    });
    this.lobby();
  }

  sendWebState(peer, frame) {
    jsonPeer(peer, {
      t: "state",
      f: frame,
      size: this.state.length,
      revision: this.revision,
    });
    binaryPeer(peer, this.state);
  }

  sendCalibration(peer, stage, state) {
    const host = this.peers.get(this.host);
    jsonPeer(host, {
      t: "native-calibration",
      player: peer.player,
      stage,
      size: state.length,
    });
    binaryPeer(host, state);
  }

  maybeStart() {
    if (
      this.started ||
      this.closed ||
      (this.manifest.manualStart && !this.starting) ||
      !this.state ||
      this.pendingBatteries.size ||
      (!this.hadGame && this.peers.size !== this.manifest.players)
    )
      return;
    for (const peer of this.peers.values()) {
      if (
        peer.kind === "native"
          ? !peer.ready || (peer.restarting && !peer.restartReady)
          : !peer.battery || peer.ready !== this.revision
      )
        return;
    }
    this.started = true;
    this.hadGame = true;
    clearTimeout(this.timer);
    for (const peer of this.peers.values())
      if (peer.kind === "native") peer.start();
    this.finishStart();
  }

  finishStart() {
    if (this.running) return;
    for (const peer of this.peers.values())
      if (
        peer.kind === "native" &&
        (!peer.bootstrapped || (peer.calibration && !peer.calibrated))
      )
        return;
    this.running = true;
    this.starting = false;
    this.nativeClockAt = performance.now();
    for (const peer of this.peers.values()) peer.playing = true;
    for (const peer of this.peers.values())
      if (peer.kind === "native") peer.finishStart();
    for (const peer of this.peers.values())
      jsonPeer(peer, {
        t: "start",
        f: 0,
        player: peer.player,
        players: this.manifest.players,
        maxPrediction: this.manifest.maxPrediction,
        ...(this.manifest.manualStart ? { generation: this.generation } : {}),
      });
    for (const peer of this.peers.values())
      if (peer.kind === "native") peer.flushInputs?.();
    this.lobby();
  }

  input(peer, frame, buttons) {
    if (
      !this.running ||
      !uint(frame) ||
      !uint(buttons) ||
      buttons > 65535 ||
      frame !== peer.nextFrame
    )
      throw new Error("Input frames must be sequential");
    if (frame > this.progress + 120)
      throw new Error("Input exceeds host frame window");
    peer.nextFrame++;
    if (
      this.manifest.manualStart &&
      ![...this.peers.values()].some(
        (other) => other.kind === "web" && other.playing,
      )
    ) {
      this.progress = Math.max(this.progress, frame);
      this.confirmed = Math.max(this.confirmed, frame);
    }
    if (peer.player === this.host) {
      for (const other of this.peers.values())
        if (other.kind === "native" && other.slave)
          this.input(other, frame, other.buttons);
    }
    if (this.requestedFrame !== undefined && frame >= this.requestedFrame) {
      if (this.heldInputs.length >= 512)
        throw new Error("State synchronization queue exceeded");
      this.heldInputs.push([peer, frame, buttons]);
      return;
    }
    this.relayInput(peer, frame, buttons);
    this.fillVacancies();
  }

  relayInput(peer, frame, buttons) {
    for (const other of this.peers.values()) {
      if (this.manifest.manualStart && !other.playing) continue;
      if (other === peer && !peer.slave) continue;
      if (other.kind === "native") other.sendInput(frame, peer.player, buttons);
      else
        jsonPeer(other, {
          t: "input",
          f: frame,
          b: buttons,
          player: peer.player,
          ...(this.manifest.manualStart ? { generation: this.generation } : {}),
        });
    }
    if (peer.player === 0) this.nextHostFrame = frame + 1;
  }

  checksum(peer, data) {
    if (
      !this.running ||
      !uint(data.f) ||
      !uint(data.crc) ||
      data.f > peer.confirmed ||
      data.f < (peer.lastCheckpoint ?? 0) ||
      data.f < this.latestCheckpoint - 600
    )
      throw new Error("Invalid checkpoint");
    const checks = this.crcs.get(data.f) ?? new Map();
    const previous = checks.get(peer.player);
    if (previous !== undefined && previous !== data.crc)
      throw new Error("Conflicting checkpoint");
    checks.set(peer.player, data.crc);
    this.crcs.set(data.f, checks);
    peer.lastCheckpoint = data.f;
    this.latestCheckpoint = Math.max(this.latestCheckpoint, data.f);
    const host = checks.get(this.host);
    if (host !== undefined) {
      for (const value of checks.values())
        if (value !== host)
          throw new Error(`State mismatch at frame ${data.f}`);
      if (peer.player === this.host)
        for (const other of this.peers.values())
          if (other.kind === "native") other.sendCrc(data.f, data.crc);
    }
    for (const frame of this.crcs.keys())
      if (frame < this.latestCheckpoint - 600) this.crcs.delete(frame);
  }

  requestState(peer) {
    if (!this.started) throw new Error("State requested before start");
    if (this.manifest.maxPrediction)
      throw new Error("Rollback state mismatch; core compatibility failed");
    const now = Date.now();
    this.resyncs = this.resyncs.filter((time) => now - time < 60000);
    if (this.resyncs.length >= 4)
      throw new Error(
        "Repeated native state mismatch; core compatibility failed",
      );
    this.resyncs.push(now);
    if (this.requestedFrame !== undefined) return;
    this.requestedFrame = this.nextHostFrame;
    jsonPeer(this.peers.get(this.host), {
      t: "state-request",
      f: this.requestedFrame,
    });
  }

  pause(peer, paused) {
    if (!this.started) throw new Error("Pause requested before start");
    this.paused = paused;
    for (const other of this.peers.values()) {
      if (other.kind === "native") {
        if (other !== peer)
          other.send(
            paused ? CMD.PAUSE : CMD.RESUME,
            paused ? fixedString(peer.nickname) : undefined,
          );
      } else if (!this.manifest.manualStart || other.playing)
        jsonPeer(other, { t: "pause", paused });
    }
  }

  notify(message) {
    try {
      for (const peer of this.peers.values()) jsonPeer(peer, message);
    } catch (error) {
      this.close(error.message);
    }
  }

  electHost() {
    const current = this.peers.get(this.host);
    if (current?.kind === "web" && (current.playing || !this.running)) return;
    const web = [...this.peers.values()].filter((peer) => peer.kind === "web");
    const next = web.find((peer) => peer.playing) ?? web[0];
    this.host = next?.player ?? null;
    this.manifest.owner = next?.owner ?? "";
    if (next?.playing) {
      this.progress = next.frame;
      this.confirmed = next.confirmed;
    }
  }

  fillVacancies() {
    if (!this.manifest.manualStart || !this.running) return;
    const active = [...this.peers.values()].filter((peer) => peer.playing);
    if (!active.length) return;
    const end = Math.max(...active.map((peer) => peer.nextFrame));
    for (const [player, next] of this.vacant) {
      for (let frame = next; frame < end; frame++)
        this.relayInput({ player }, frame, 0);
      this.vacant.set(player, Math.max(next, end));
    }
  }

  tickNativeClock() {
    if (
      !this.running ||
      this.paused ||
      [...this.peers.values()].some(
        (peer) => peer.kind === "web" && peer.playing,
      )
    ) {
      this.nativeClockAt = performance.now();
      return;
    }
    const slaves = [...this.peers.values()].filter(
      (peer) => peer.kind === "native" && peer.slave && peer.playing,
    );
    if (!slaves.length) return;
    const now = performance.now(),
      interval = 1000 / (this.manifest.system === "snes" ? 60.0988 : 59.7275);
    if (now - this.nativeClockAt < interval) return;
    this.nativeClockAt = now;
    for (const peer of slaves) {
      if (peer.nextFrame > peer.lastReportedFrame - peer.frameOffset + 3)
        continue;
      this.input(peer, peer.nextFrame, peer.buttons);
    }
  }

  probePeers() {
    this.expireReservations();
    if (!this.peers.size && !this.reservations.size) {
      this.close("No players connected");
      return;
    }
    const now = performance.now();
    for (const peer of this.peers.values()) {
      if (peer.kind === "native" && peer.phase !== "connected") continue;
      if (peer.probe) {
        if (now - peer.probe.sent > 6000) peer.ping = null;
        if (now - peer.probe.sent > 15000) {
          if (peer.kind === "native") peer.close();
          else peer.ws.terminate();
        }
        continue;
      }
      peer.probe = { sent: now, nonce: token() };
      try {
        if (peer.kind === "native") peer.send(CMD.PING);
        else jsonPeer(peer, { t: "ping", nonce: peer.probe.nonce });
      } catch {
        if (peer.kind === "native") peer.close();
        else peer.ws.terminate();
      }
    }
    this.publishPings();
  }

  pong(peer, nonce) {
    if (!peer.probe || (peer.kind === "web" && peer.probe.nonce !== nonce))
      return;
    const sample = performance.now() - peer.probe.sent;
    peer.ping = Math.round(
      peer.ping === null || peer.ping === undefined
        ? sample
        : peer.ping * 0.7 + sample * 0.3,
    );
    peer.probe = null;
    this.publishPings();
  }

  publishPings() {
    this.notify({
      t: "latency",
      members: [...this.peers.values()].map((peer) => ({
        player: peer.player,
        ping: peer.ping ?? null,
      })),
    });
  }

  depart(peer, message) {
    if (this.closed || this.peers.get(peer.player) !== peer) return;
    this.peers.delete(peer.player);
    this.pendingBatteries.delete(peer.player);
    if (this.manifest.manualStart) {
      if (!this.peers.size) {
        this.close("The last player left");
        return;
      }
      const wasHost = peer.player === this.host;
      if (peer.playing && this.running)
        this.vacant.set(peer.player, peer.nextFrame);
      this.seats[peer.player] = null;
      this.electHost();
      this.notify({ t: "peer-left", player: peer.player, message });
      if (this.starting && wasHost && this.host !== null) this.prepareGame();
      else if (this.starting) this.maybeStart();
      this.fillVacancies();
      this.lobby();
      return;
    }
    if (this.started || this.starting || peer.player === 0) this.close(message);
    else {
      this.notify({ t: "peer-left", player: peer.player, message });
      this.lobby();
    }
  }

  close(message = "Room closed") {
    if (this.closed) return;
    this.bridge.log("room-closed", {
      room: this.id,
      port: this.tcpPort ?? null,
      reason: message,
    });
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    clearInterval(this.nativeClock);
    this.bridge.rooms.delete(this.id);
    for (const peer of this.peers.values()) {
      if (peer.kind === "native") peer.close();
      else {
        try {
          jsonPeer(peer, { t: "disconnect", message });
        } catch {
          /* The connection may already be congested. */
        }
        peer.ws.close(1000, "Room closed");
      }
    }
    this.listener?.close();
    this.peers.clear();
    this.reservations.clear();
    this.state = null;
  }
}

export async function createBridge({
  adminToken,
  host = "127.0.0.1",
  port = 0,
  nativeHost = "127.0.0.1",
  portStart = 55435,
  portEnd = 55442,
  maxRooms = 8,
  allowedOrigins = [],
  logger = (entry) => console.info(JSON.stringify(entry)),
} = {}) {
  if (typeof adminToken !== "string" || adminToken.length < 24)
    throw new Error("Bridge admin token must contain at least 24 characters");
  const rooms = new Map();
  const bridge = {
    rooms,
    log(event, fields = {}) {
      logger({ time: new Date().toISOString(), event, ...fields });
    },
  };
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_STATE,
    perMessageDeflate: false,
  });
  async function body(request) {
    let total = 0;
    const parts = [];
    for await (const chunk of request) {
      total += chunk.length;
      if (total > MAX_JSON) throw new Error("Request body is too large");
      parts.push(chunk);
    }
    return JSON.parse(Buffer.concat(parts).toString() || "{}");
  }
  const http = createHttpServer(async (request, response) => {
    const reply = (status, value) => {
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(value));
    };
    try {
      const path = new URL(request.url, "http://bridge").pathname;
      if (path === "/health" && request.method === "GET")
        return reply(200, { status: "ok", rooms: rooms.size });
      if (!secretEqual(request.headers.authorization, `Bearer ${adminToken}`))
        return reply(401, { error: "Unauthorized" });
      if (path === "/v1/rooms" && request.method === "GET")
        return reply(
          200,
          [...rooms.values()].map((room) => room.metadata()),
        );
      if (path === "/v1/rooms" && request.method === "POST") {
        if (rooms.size >= maxRooms)
          return reply(409, { error: "Room capacity reached" });
        const data = await body(request);
        const manifest = validateManifest(data);
        if (rooms.size >= maxRooms)
          return reply(409, { error: "Room capacity reached" });
        if (
          manifest.owner &&
          [...rooms.values()].some(
            (room) => room.manifest.owner === manifest.owner,
          )
        )
          return reply(409, { error: "Owner already hosts a room" });
        const password = boundedString(
          data.password,
          randomBytes(6).toString("hex"),
          120,
        );
        const room = new Room(bridge, manifest, password);
        rooms.set(room.id, room);
        if (manifest.nativeAllowed) {
          let allocated = false;
          for (let candidate = portStart; candidate <= portEnd; candidate++) {
            const listener = createTcpServer((socket) => {
              const slot = room.available(true);
              if (
                room.closed ||
                (room.started && !room.manifest.manualStart) ||
                room.starting ||
                slot < 0
              ) {
                bridge.log("native-rejected", {
                  room: room.id,
                  port: room.tcpPort,
                  remoteAddress: socket.remoteAddress,
                  reason: room.closed
                    ? "Room closed"
                    : room.starting
                      ? "Room is starting"
                      : slot < 0
                        ? "Room is full"
                        : "Room has started",
                });
                socket.destroy();
                return;
              }
              const peer = new NativePeer(room, socket, slot);
              room.peers.set(slot, peer);
              if (room.manifest.manualStart) room.seats[slot] = null;
              room.lobby();
            });
            try {
              await new Promise((resolve, reject) => {
                listener.once("error", reject);
                listener.listen(candidate, nativeHost, () => {
                  listener.removeListener("error", reject);
                  resolve();
                });
              });
              listener.on("error", () => room.close("Native listener failed"));
              room.listener = listener;
              room.tcpPort = listener.address().port;
              allocated = true;
              break;
            } catch (error) {
              if (error.code !== "EADDRINUSE") {
                room.close();
                throw error;
              }
            }
          }
          if (!allocated) {
            room.close();
            return reply(409, { error: "No native ports available" });
          }
        }
        const hostToken = room.reserve(0, manifest.owner, manifest.nickname);
        bridge.log("room-created", {
          room: room.id,
          port: room.tcpPort ?? null,
          coreName: manifest.coreName,
          coreVersion: manifest.coreVersion,
          nativeAllowed: manifest.nativeAllowed,
          players: manifest.players,
        });
        return reply(201, {
          id: room.id,
          hostToken,
          hostPath: `/v1/rooms/${room.id}/host?token=${hostToken}`,
          tcpPort: room.tcpPort ?? null,
          password,
          players: manifest.players,
        });
      }
      const match = path.match(/^\/v1\/rooms\/([A-Za-z0-9_-]+)(\/join)?$/);
      const room = match && rooms.get(match[1]);
      if (!room) return reply(404, { error: "Room not found" });
      if (request.method === "DELETE" && !match[2]) {
        room.close();
        return reply(200, { closed: true });
      }
      if (request.method === "POST" && match[2]) {
        const data = await body(request);
        if ((room.started && !room.manifest.manualStart) || room.starting)
          return reply(409, { error: "Room has started" });
        if (room.password && !secretEqual(data.password, room.password))
          return reply(403, { error: "Incorrect room password" });
        const slot = room.available();
        if (slot < 0) return reply(409, { error: "Room is full" });
        const owner = boundedString(data.owner, "", 128);
        const nickname = boundedString(data.nickname, "Web player", 31);
        const peerToken = room.reserve(slot, owner, nickname);
        return reply(201, {
          id: room.id,
          player: slot,
          peerToken,
          peerPath: `/v1/rooms/${room.id}/peer?token=${peerToken}`,
          tcpPort: room.tcpPort ?? null,
          password: room.password,
          players: room.manifest.players,
        });
      }
      return reply(405, { error: "Method not allowed" });
    } catch (error) {
      reply(400, { error: error.message });
    }
  });
  http.requestTimeout = 15000;
  http.headersTimeout = 10000;
  http.on("upgrade", (request, socket, head) => {
    const reject = () => {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    };
    const url = new URL(request.url, "http://bridge");
    const match = url.pathname.match(
      /^\/v1\/rooms\/([A-Za-z0-9_-]+)\/(host|peer)$/,
    );
    const room = match && rooms.get(match[1]);
    if (
      !room ||
      (room.started && !room.manifest.manualStart) ||
      room.starting ||
      (allowedOrigins.length &&
        !allowedOrigins.includes(request.headers.origin))
    )
      return reject();
    const credential = url.searchParams.get("token");
    for (const [slot, reservation] of room.reservations) {
      if (
        (match[2] === "host" && slot !== 0) ||
        reservation.until < Date.now() ||
        !secretEqual(credential, reservation.credential)
      )
        continue;
      room.reservations.delete(slot);
      wss.handleUpgrade(request, socket, head, (ws) =>
        room.attach(ws, slot, reservation),
      );
      return;
    }
    reject();
  });
  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, resolve);
  });
  return {
    rooms,
    http,
    address: http.address(),
    close: async () => {
      for (const room of [...rooms.values()]) room.close();
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => http.close(resolve));
      wss.close();
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const service = await createBridge({
    adminToken: process.env.NETPLAY_BRIDGE_ADMIN_TOKEN,
    host: process.env.NETPLAY_BRIDGE_BIND ?? "0.0.0.0",
    port: Number(process.env.NETPLAY_BRIDGE_HTTP_PORT ?? 8080),
    nativeHost: process.env.NETPLAY_BRIDGE_BIND ?? "0.0.0.0",
    portStart: Number(process.env.NETPLAY_BRIDGE_TCP_START ?? 55435),
    portEnd: Number(process.env.NETPLAY_BRIDGE_TCP_END ?? 55442),
    allowedOrigins: (process.env.NETPLAY_BRIDGE_ORIGINS ?? "")
      .split(",")
      .filter(Boolean),
  });
  console.info(`Netplay bridge listening on port ${service.address.port}`);
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, async () => {
      await service.close();
      process.exit(0);
    });
}
