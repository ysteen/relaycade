import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { NativePeer, PACING_LEAD } from "./native.mjs";
import {
  cartridgeManifest,
  cartridgeDescription,
  decodeBattery,
  NATIVE_PREPARE_MS,
  passwordMatches,
} from "./native-launch.mjs";
import { CMD, MAX_STATE, fixedString } from "./wire.mjs";
import { extractSaves, supportsSaves } from "./save-extract.mjs";
import { SaveOutbox } from "./save-outbox.mjs";
import { BridgeAdmin, adminAsset } from "./admin.mjs";
import { cableInputProfile, CABLE_INPUT } from "./client/link-core.js";

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
  if (
    body.disconnectPolicy !== undefined &&
    !["continue", "pause"].includes(body.disconnectPolicy)
  )
    throw new Error("Invalid disconnect policy");
  if (body.disconnectPolicy === "pause" && !body.manualStart)
    throw new Error("Disconnect pause requires a lobby");
  const cartridges = cartridgeManifest(body);
  if (
    body.saveSize !== undefined &&
    (!Number.isInteger(body.saveSize) ||
      body.saveSize < 0 ||
      body.saveSize > 131072)
  )
    throw new Error("Invalid cartridge save size");
  if (
    body.nativeAuthority !== undefined &&
    typeof body.nativeAuthority !== "boolean"
  )
    throw new Error("Invalid native authority flag");
  if (
    body.nativeAuthority &&
    (!body.nativeAuth || !body.manualStart || !maxPrediction || !cartridges)
  )
    throw new Error("Native authority requires an authenticated rollback room");
  if (
    cartridges &&
    (cartridges[0].romId !== body.romId ||
      cartridges[0].crc32 !== body.contentCrc)
  )
    throw new Error("Primary cartridge does not match the room");
  if (body.nativeAuth !== undefined && typeof body.nativeAuth !== "boolean")
    throw new Error("Invalid native authentication flag");
  if (body.nativeAuth && (!cartridges || !body.manualStart))
    throw new Error(
      "Native preparation requires a cartridge manifest and lobby",
    );
  if (
    body.collectCartridges !== undefined &&
    typeof body.collectCartridges !== "boolean"
  )
    throw new Error("Invalid cartridge collection flag");
  if (
    body.collectCartridges &&
    (!["gb", "gba"].includes(body.system) || !body.manualStart || !cartridges)
  )
    throw new Error("Cartridge collection requires a GB/GBC or GBA lobby");
  return {
    system: body.system,
    players: body.players,
    stateSize: body.stateSize,
    contentCrc: body.contentCrc,
    coreName,
    coreVersion,
    maxPrediction,
    owner,
    inputProfile: cableInputProfile(coreName, coreVersion),
    romId: body.romId ?? null,
    cartridges,
    saveSize: body.saveSize,
    saveAllowed: body.saveAllowed === true,
    collectCartridges: body.collectCartridges ?? false,
    nativeAuth: body.nativeAuth ?? false,
    nativeAuthority: body.nativeAuthority ?? false,
    nativeAllowed: body.nativeAllowed ?? false,
    manualStart: body.manualStart ?? false,
    disconnectPolicy: body.disconnectPolicy ?? "continue",
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
      controllers: new Map(),
      reservations: new Map(),
      pendingNative: new Set(),
      pendingBatteries: new Set(),
      removedOwners: new Set(),
    });
    this.state = null;
    this.gameOwners = null;
    this.saveDigests = new Map();
    this.lastSaveCapture = 0;
    this.saveRequest = null;
    this.saveError = null;
    this.contentPrepared = !manifest.collectCartridges;
    this.loadingContent = false;
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
    this.detached = new Set();
    this.inputHistory = Array.from(
      { length: manifest.players },
      () => new Map(),
    );
    this.resumes = new Map();
    this.disconnectedPlayers = new Set();
    this.disconnectPause = null;
    this.manualPaused = false;
    this.paused = false;
    if (manifest.manualStart) {
      this.heartbeat = setInterval(() => this.probePeers(), 2000);
      this.heartbeat.unref();
      this.nativeClock = setInterval(() => this.tickNativeClock(), 8);
      this.nativeClock.unref();
    }
    if (!manifest.manualStart) {
      this.timer = setTimeout(
        () => this.close("Room setup timed out"),
        5 * 60000,
      );
      this.timer.unref();
    }
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
      inputProfile: this.manifest.inputProfile,
      started: this.started || this.starting,
      tcpPort: this.tcpPort ?? null,
      hasPassword: !!this.password,
      cartridges: this.manifest.cartridges,
      nativeAuth: this.manifest.nativeAuth,
      nativeAuthority: this.manifest.nativeAuthority,
      collectCartridges: this.manifest.collectCartridges,
      contentPrepared: this.contentPrepared,
      disconnectPolicy: this.manifest.disconnectPolicy,
      waitingForPlayers: this.disconnectPause
        ? [...this.disconnectedPlayers]
        : [],
      members: this.members(),
      seats: this.seats,
      generation: this.generation,
      requiresNewGame: this.needsNewGame(),
      saveOwners:
        this.gameOwners?.map((entry) =>
          entry
            ? { player: entry.player, owner: entry.owner, romId: entry.romId }
            : null,
        ) ?? null,
      host: this.host,
      saveHost: this.saveHost(),
      saves: this.saveStatus(),
      canStart: this.canStart(),
      running: !!this.running,
      starting: this.starting || this.loadingContent,
    };
  }

  reserve(player, owner, nickname, extra = {}) {
    const credential = token();
    this.reservations.set(player, {
      credential,
      owner,
      nickname,
      until: Date.now() + TOKEN_LIFETIME,
      ...extra,
    });
    return credential;
  }

  expireReservations() {
    let changed = false;
    for (const [slot, reservation] of this.reservations) {
      if (reservation.until < Date.now()) {
        this.reservations.delete(slot);
        if (!this.returnController(slot)) {
          this.detachCable(slot);
          this.seats[slot] = null;
        }
        this.loadingContent = false;
        changed = true;
      }
    }
    if (changed) this.electHost();
  }

  members() {
    return [
      ...[...this.peers.values()].map((peer) => ({
        player: peer.player,
        owner: peer.owner ?? "",
        romId: peer.romId ?? null,
        clientPlatform: peer.clientPlatform ?? null,
        nickname: peer.nickname,
        kind: peer.kind,
        ready:
          peer.kind === "web"
            ? !peer.gameClosed && this.wantsToPlay(peer)
            : peer.ready,
        playing: !!peer.playing,
        ping: peer.ping ?? null,
        waitingForNewGame:
          this.seats[peer.player] !== null && !this.canUseGame(peer),
      })),
      ...[...this.reservations]
        .filter(([, item]) => item.kind === "native")
        .map(([player, item]) => ({
          player,
          owner: item.owner,
          romId: item.romId,
          clientPlatform: item.clientPlatform ?? null,
          nickname: item.nickname,
          kind: "preparing",
          ready: false,
          playing: false,
          ping: null,
          waitingForNewGame:
            this.seats[player] !== null &&
            !this.canUseGame({ ...item, player }),
        })),
    ];
  }

  returnController(player) {
    const controller = this.controllers.get(player);
    if (!controller || controller.ws.readyState !== WebSocket.OPEN)
      return false;
    this.controllers.delete(player);
    this.peers.set(player, controller);
    controller.gameClosed = true;
    controller.resumeAllowed = false;
    controller.playing = controller.contentReady = controller.reloading = false;
    controller.ready = -1;
    controller.transfer = null;
    jsonPeer(controller, { t: "returned", generation: this.generation });
    return true;
  }

  removeController(player, message) {
    const controller = this.controllers.get(player);
    if (!controller) return;
    this.detachCable(player);
    this.controllers.delete(player);
    try {
      jsonPeer(controller, {
        t: "disconnect",
        ...(message ? { message } : {}),
      });
    } catch {
      /* A stalled room page must not prevent membership revocation. */
    }
    controller.ws.close(1000, "Left the room");
  }

  nativeReservation(credential) {
    this.expireReservations();
    for (const [player, item] of this.reservations)
      if (item.kind === "native" && secretEqual(credential, item.credential))
        return { player, item };
    for (const [player, item] of this.peers)
      if (
        item.kind === "native" &&
        item.credential &&
        secretEqual(credential, item.credential)
      )
        return { player, item };
    return null;
  }

  admitNative(peer, response) {
    if (
      !this.contentPrepared ||
      (this.manifest.collectCartridges &&
        !this.state &&
        !this.manifest.nativeAuthority)
    )
      return false;
    this.expireReservations();
    for (const [player, item] of this.reservations) {
      if (
        item.kind !== "native" ||
        !passwordMatches(peer.salt, item.nativePassword, response)
      )
        continue;
      if (
        !this.canReceiveGame({ ...item, player }) ||
        (this.gameOwners &&
          this.seats[player] !== null &&
          !this.matchesGameCartridge({ ...item, player }))
      )
        return false;
      this.reservations.delete(player);
      this.pendingNative.delete(peer);
      Object.assign(peer, {
        player,
        owner: item.owner,
        saveAllowed: item.saveAllowed,
        nickname: item.nickname,
        romId: item.romId,
        credential: item.credential,
        initialBattery: item.initialBattery,
        clientPlatform: item.clientPlatform,
        cartridge: item.cartridge,
        until: item.until,
      });
      this.peers.set(player, peer);
      this.electHost();
      this.lobby();
      return true;
    }
    return false;
  }

  assignSeat(peer, player, seat) {
    if (!this.manifest.manualStart || this.starting || this.loadingContent)
      return "The room is not accepting player changes";
    if (peer.player !== this.host && player !== peer.player)
      return "You can only change your own player number";
    const target = this.peers.get(player) ?? this.reservations.get(player);
    if (
      !Number.isInteger(player) ||
      !target ||
      (seat !== null &&
        (!Number.isInteger(seat) || seat < 0 || seat >= this.manifest.players))
    )
      return "Choose a connected player and a valid player number";
    if (this.running && target.playing)
      return "Player numbers are fixed until the next game";
    const other = this.seats.indexOf(seat);
    if (seat !== null && other !== -1 && other !== player)
      return "That player number is already selected";
    this.seats[player] = seat;
    this.lobby();
    this.resumeGame(target);
    return null;
  }

  available(native = false, owner = "") {
    this.expireReservations();
    const previous =
      owner && this.gameOwners?.find((entry) => entry?.owner === owner);
    if (
      previous &&
      !this.peers.has(previous.player) &&
      !this.reservations.has(previous.player)
    )
      return previous.player;
    for (
      let slot =
        !native && this.manifest.manualStart && !this.peers.has(0) ? 0 : 1;
      slot < this.manifest.players;
      slot++
    )
      if (!this.peers.has(slot) && !this.reservations.has(slot)) return slot;
    return -1;
  }

  wantsToPlay(peer) {
    return !peer.joinRequired || peer.resumeAllowed === true;
  }

  sameGameOwner(entry, peer) {
    return (
      entry.player === peer.player &&
      (entry.owner
        ? entry.owner === peer.owner
        : entry.identity === peer.identity) &&
      entry.romId === (peer.romId ?? this.manifest.romId)
    );
  }

  canUseGame(peer) {
    if (!this.gameOwners) return true;
    const seat = this.seats[peer.player];
    if (seat === null || seat === undefined) return false;
    const entry = this.gameOwners[seat];
    if (entry) return this.sameGameOwner(entry, peer);
    if (this.hadGame) return false;
    return this.gameOwners.every((saved) => {
      if (!saved) return true;
      const member =
        this.peers.get(saved.player) ?? this.reservations.get(saved.player);
      return (
        saved.player !== peer.player &&
        member &&
        this.sameGameOwner(saved, { ...member, player: saved.player })
      );
    });
  }

  canReceiveGame(peer) {
    return (
      !this.gameOwners ||
      this.gameOwners.some(
        (entry) => entry && this.sameGameOwner(entry, peer),
      ) ||
      this.canUseGame(peer)
    );
  }

  bindGameOwners() {
    if (!this.manifest.manualStart || this.hadGame) return;
    const owners = this.gameOwners ?? Array(this.manifest.players).fill(null);
    for (const [player, member] of [...this.peers, ...this.reservations]) {
      const seat = this.seats[player];
      if (
        seat === null ||
        owners[seat] ||
        !this.canUseGame({ ...member, player })
      )
        continue;
      member.identity ??= token();
      owners[seat] = {
        player,
        owner: member.owner ?? "",
        identity: member.identity,
        romId: member.romId ?? this.manifest.romId,
        saveAllowed: member.saveAllowed === true,
      };
    }
    if (owners.some(Boolean)) this.gameOwners = owners;
  }

  ownershipWaiting(peer) {
    jsonPeer(this.controllers.get(peer.player) ?? peer, {
      t: "action-error",
      message:
        "This player number belongs to another account or cartridge in the current game. Choose your previous player number, or wait for the host to prepare the next game with your own save.",
    });
  }

  saveHost() {
    return (
      [...this.peers.values()].find(
        (peer) => peer.kind === "web" && peer.playing,
      )?.player ?? null
    );
  }

  initialBatteries() {
    // Bind accounts before a launcher receives the shared save bundle.
    this.bindGameOwners();
    const members = [...this.peers, ...this.reservations];
    return this.manifest.cartridges.map((_, seat) => {
      const member =
        this.manifest.system === "snes"
          ? (this.peers.get(this.host) ?? this.reservations.get(this.host))
          : members.find(([player]) => this.seats[player] === seat)?.[1];
      return (member?.initialBattery ?? Buffer.alloc(0)).toString("base64");
    });
  }

  saveStatus() {
    const enabled =
      !!this.bridge.saves &&
      this.manifest.manualStart &&
      supportsSaves(this.manifest);
    const pending = this.bridge.saves?.list(this.id) ?? [];
    return {
      enabled,
      pending: pending.length,
      synced: !!this.savesSynced,
      error:
        this.saveError ?? pending.find((entry) => entry.error)?.error ?? null,
    };
  }

  publishSaveStatus() {
    if (this.closed) return;
    for (const peer of [...this.peers.values(), ...this.controllers.values()]) {
      try {
        jsonPeer(peer, { t: "save-status", ...this.saveStatus() });
      } catch {
        // Save notifications must not interrupt a running game.
      }
    }
  }

  captureSaves(peer, frame, state) {
    if (
      !this.saveStatus().enabled ||
      !this.running ||
      this.starting ||
      !peer.playing ||
      !this.canUseGame(peer) ||
      this.peers.get(peer.player) !== peer ||
      !uint(frame) ||
      frame > peer.nextFrame ||
      state.length !== this.manifest.stateSize
    )
      return Promise.reject(new Error("No active game save is available"));
    let saves;
    try {
      saves = extractSaves(this.manifest, state);
    } catch (error) {
      return Promise.reject(error);
    }
    const generation = this.generation;
    if (
      this.savedFrame?.generation === generation &&
      frame < this.savedFrame.frame
    )
      return Promise.resolve();
    this.savedFrame = { generation, frame };
    const entries = (this.gameOwners ?? [])
      .map((owner, seat) => {
        const battery = saves[this.manifest.system === "snes" ? 0 : seat];
        if (!owner?.owner || !owner.saveAllowed || !battery?.length)
          return null;
        const key = JSON.stringify([owner.owner, owner.player, owner.romId]);
        const encoded = battery.toString("base64");
        if (this.saveDigests.get(key) === encoded) return null;
        return {
          key,
          roomId: this.id,
          owner: owner.owner,
          player: owner.player,
          romId: owner.romId,
          coreName: this.manifest.coreName,
          generation,
          frame,
          battery: encoded,
        };
      })
      .filter(Boolean);
    this.lastSaveCapture = Date.now();
    const work = Promise.all(
      entries.map(({ key, ...entry }) =>
        this.bridge.saves
          .put(entry)
          .then(() => this.saveDigests.set(key, entry.battery)),
      ),
    );
    return work.then(() => {
      this.saveError = null;
      this.publishSaveStatus();
    });
  }

  saveFailed(error) {
    this.saveError = error.message;
    this.bridge.log("save-error", { room: this.id, reason: error.message });
    this.publishSaveStatus();
  }

  requestSave() {
    if (
      !this.saveStatus().enabled ||
      !this.running ||
      this.starting ||
      this.saveRequest
    )
      return;
    const source =
      [...this.peers.values()].find(
        (peer) => peer.kind === "web" && peer.playing,
      ) ?? this.peers.get(this.host);
    if (!source?.playing || !this.canUseGame(source)) return;
    this.lastSaveCapture = Date.now();
    if (source.kind === "native") {
      source.requestCheckpoint();
      return;
    }
    const request = { id: token(), source, generation: this.generation };
    request.timer = setTimeout(() => {
      if (this.saveRequest !== request) return;
      this.saveRequest = null;
      this.saveFailed(new Error("The browser save snapshot timed out"));
    }, 10000);
    request.timer.unref();
    this.saveRequest = request;
    jsonPeer(source, { t: "resume-source", id: request.id });
  }

  canStart() {
    if (this.needsNewGame()) {
      const members = [...this.peers, ...this.reservations];
      return (
        !this.starting &&
        !this.loadingContent &&
        members.length === this.manifest.players &&
        members.every(
          ([player, member]) =>
            this.seats[player] !== null &&
            (!this.manifest.collectCartridges || member.cartridge),
        )
      );
    }
    if (!this.contentPrepared) {
      const members = [...this.peers, ...this.reservations];
      return (
        !this.loadingContent &&
        members.length === this.manifest.players &&
        members.every(
          ([player, member]) =>
            this.seats[player] !== null &&
            member.cartridge &&
            this.wantsToPlay(member),
        ) &&
        (this.manifest.nativeAuthority ||
          this.peers.get(this.host)?.kind === "web")
      );
    }
    return (
      (!!this.state ||
        (this.manifest.nativeAuthority &&
          this.peers.get(this.host)?.kind === "native")) &&
      (!this.started ||
        [...this.peers.values()].some((peer) => !peer.playing)) &&
      !this.starting &&
      !this.loadingContent &&
      !this.peers.get(this.host)?.checkpointRequested &&
      !this.peers.get(this.host)?.resumeSourceId &&
      ![...this.reservations.values()].some((item) => item.kind === "native") &&
      (this.hadGame || this.peers.size === this.manifest.players) &&
      [...this.peers.keys()].every((player) => this.seats[player] !== null) &&
      [...this.peers.values()].every((peer) =>
        peer.kind === "web"
          ? !peer.gameClosed && peer.contentReady && this.wantsToPlay(peer)
          : peer.ready,
      )
    );
  }

  lobby() {
    if (!this.manifest.manualStart || this.closed) return;
    if (
      this.loadingContent &&
      (this.state ||
        (this.manifest.nativeAuthority &&
          this.peers.get(this.host)?.kind === "native")) &&
      this.peers.size === this.manifest.players &&
      [...this.peers.values()].every((peer) =>
        peer.kind === "web"
          ? !peer.gameClosed && peer.contentReady && this.wantsToPlay(peer)
          : peer.ready,
      )
    ) {
      this.loadingContent = false;
      this.starting = true;
      this.beginStart();
      return;
    }
    this.notify({
      t: "lobby",
      generation: this.generation,
      requiresNewGame: this.needsNewGame(),
      players: this.manifest.players,
      seats: this.seats,
      host: this.host,
      saveHost: this.saveHost(),
      saves: this.saveStatus(),
      running: !!this.running,
      starting: this.starting || this.loadingContent,
      contentPrepared: this.contentPrepared,
      disconnectPolicy: this.manifest.disconnectPolicy,
      waitingForPlayers: this.disconnectPause
        ? [...this.disconnectedPlayers]
        : [],
      collectCartridges: this.manifest.collectCartridges,
      cartridges: this.manifest.cartridges,
      canStart: this.canStart(),
      members: this.members(),
    });
  }

  control(peer, data) {
    const reject = (message) => {
      jsonPeer(peer, { t: "action-error", message });
      return message;
    };
    if (!this.manifest.manualStart)
      return reject("This room does not have a lobby");
    if (data.t === "disconnect-policy") {
      if (this.starting || this.loadingContent)
        return reject("The game is already starting");
      if (peer.player !== this.host)
        return reject("Only the host can change the disconnect policy");
      if (!["continue", "pause"].includes(data.disconnectPolicy))
        return reject("Invalid disconnect policy");
      if (
        data.disconnectPolicy === "pause" &&
        [...this.peers.values()].some(
          (p) => p.kind === "native" && !p.managedPause,
        )
      )
        return reject(
          "Update and register every Windows launcher before enabling pause on disconnect",
        );
      this.manifest.disconnectPolicy = data.disconnectPolicy;
      if (data.disconnectPolicy === "continue") {
        this.disconnectPause = null;
        for (const request of [...this.resumes.values()])
          if (request.autoResume) this.cancelResume(request);
        this.setPaused(this.manualPaused, null, true);
        for (const other of this.peers.values()) this.resumeGame(other);
      } else this.pauseForDisconnect();
      this.lobby();
      return;
    }
    if (data.t === "kick") {
      if (peer.player !== this.host)
        return reject("Only the host can remove a player");
      if (!Number.isInteger(data.player) || data.player === peer.player)
        return reject("Choose another player to remove");
      const target =
        this.peers.get(data.player) ?? this.reservations.get(data.player);
      if (!target) return reject("That player has already left");
      if (target.owner) this.removedOwners.add(target.owner);
      this.removeController(data.player, "Removed from the room by the host");
      this.reservations.delete(data.player);
      this.detachCable(data.player);
      this.seats[data.player] = null;
      this.loadingContent = false;
      const message = "Removed from the room by the host";
      if (target.kind === "web") {
        jsonPeer(target, { t: "disconnect", message });
        this.depart(target, message);
        target.ws.close(4003, message);
      } else if (this.peers.has(data.player)) target.drop(message);
      this.lobby();
      return;
    }
    if (this.starting || this.loadingContent)
      return reject("The game is already starting");
    if (data.t === "assign") {
      const error = this.assignSeat(peer, data.player, data.seat);
      if (error) return reject(error);
      return;
    }
    if (peer.player !== this.host)
      return reject("Only the host can start the game");
    if (!this.canStart())
      return reject(
        "Wait for every player to connect and choose a player number",
      );
    if (this.needsNewGame()) {
      this.resetContent();
      return;
    }
    if (!this.contentPrepared) {
      const cartridges = Array(this.manifest.players);
      for (const [player, member] of [...this.peers, ...this.reservations])
        cartridges[this.seats[player]] = member.cartridge;
      this.manifest.cartridges = cartridges;
      this.manifest.romId = cartridges[0].romId;
      this.manifest.contentCrc = cartridges[0].crc32;
      this.contentPrepared = true;
      this.bindGameOwners();
      this.loadingContent = true;
      for (const member of this.peers.values()) this.sendContent(member);
      this.lobby();
      return;
    }
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
    this.beginStart();
  }

  beginStart() {
    this.bindGameOwners();
    const host = this.peers.get(this.host);
    if (this.manifest.nativeAuthority && host?.kind === "native") {
      host.requestRestartSource();
      this.lobby();
    } else this.prepareGame();
  }

  contentPacket() {
    return {
      t: "content",
      cartridges: this.manifest.cartridges,
      contentCrc: this.manifest.contentCrc,
      coreVersion: this.manifest.coreVersion,
    };
  }

  sendContent(peer) {
    if (
      peer.kind !== "web" ||
      peer.gameClosed ||
      peer.contentReady ||
      peer.reloading ||
      !this.canUseGame(peer)
    )
      return;
    peer.reloading = true;
    jsonPeer(peer, this.contentPacket());
  }

  needsNewCartridges() {
    return (
      this.manifest.collectCartridges &&
      this.contentPrepared &&
      [...this.peers, ...this.reservations].some(
        ([player, member]) =>
          this.seats[player] !== null &&
          !this.matchesGameCartridge({ ...member, player }),
      )
    );
  }

  needsNewGame() {
    return (
      this.needsNewCartridges() ||
      (!!this.gameOwners &&
        [...this.peers, ...this.reservations].some(
          ([player, member]) =>
            this.seats[player] !== null &&
            !this.canUseGame({ ...member, player }),
        ))
    );
  }

  resetContent() {
    this.saveDigests.clear();
    clearTimeout(this.saveRequest?.timer);
    this.saveRequest = null;
    this.started = this.running = this.starting = this.loadingContent = false;
    this.contentPrepared = !this.manifest.collectCartridges;
    this.hadGame = this.paused = this.manualPaused = false;
    this.disconnectPause = null;
    this.disconnectedPlayers.clear();
    this.gameOwners = null;
    this.startPlayers = null;
    this.generation++;
    this.nativePacingSource = null;
    this.state = null;
    this.sram = Buffer.alloc(0);
    this.pendingBatteries.clear();
    this.vacant.clear();
    this.detached.clear();
    this.crcs.clear();
    this.heldInputs.length = 0;
    this.progress = this.confirmed = this.nextHostFrame = 0;
    for (const history of this.inputHistory) history.clear();
    for (const request of [...this.resumes.values()])
      this.cancelResume(request);
    for (const peer of [...this.peers.values()]) {
      if (peer.kind !== "native") continue;
      peer.close();
      this.depart(peer, "The host is preparing a new game");
    }
    for (const [player, member] of this.reservations) {
      if (member.kind !== "native") continue;
      this.reservations.delete(player);
      this.returnController(player);
    }
    for (const peer of this.peers.values()) {
      peer.gameClosed = true;
      peer.resumeAllowed =
        peer.playing =
        peer.contentReady =
        peer.reloading =
          false;
      peer.ready = -1;
      peer.cartridgeNotice = false;
      jsonPeer(peer, { t: "game-reset", generation: this.generation });
    }
    this.electHost();
    this.lobby();
  }

  closeGame(peer) {
    if (!this.manifest.manualStart || peer.kind !== "web" || peer.gameClosed)
      return;
    for (const request of [...this.resumes.values()])
      if (request.peer === peer || request.source === peer)
        this.cancelResume(request);
    if (peer.playing && this.running) {
      this.vacant.set(peer.player, peer.nextFrame);
      this.disconnectedPlayers.add(peer.player);
    }
    peer.gameClosed = true;
    peer.playing = peer.contentReady = peer.reloading = false;
    peer.ready = -1;
    this.pendingBatteries.delete(peer.player);
    this.loadingContent = false;
    if (!this.running) this.started = this.starting = false;
    if (![...this.peers.values()].some((other) => other.playing)) {
      this.started = this.running = this.starting = false;
      this.paused = false;
    }
    this.electHost();
    this.pauseForDisconnect();
    this.fillVacancies();
    this.lobby();
  }

  openGame(peer) {
    if (!this.manifest.manualStart || peer.kind !== "web" || peer.playing)
      return;
    peer.resumeAllowed = true;
    peer.gameClosed = false;
    if (!this.canUseGame(peer)) {
      this.ownershipWaiting(peer);
      this.lobby();
      return;
    }
    if (
      this.running &&
      this.seats[peer.player] !== null &&
      !this.matchesGameCartridge(peer)
    ) {
      this.cartridgeWaiting(peer);
      this.lobby();
      return;
    }
    if (peer.contentReady) this.resumeGame(peer);
    else if (this.contentPrepared) this.sendContent(peer);
    this.lobby();
  }

  leaveOwner(owner) {
    for (const [player, controller] of this.controllers)
      if (controller.owner === owner) this.removeController(player);
    for (const [player, member] of this.reservations)
      if (member.owner === owner) {
        this.detachCable(player);
        this.reservations.delete(player);
        this.seats[player] = null;
      }
    for (const peer of [...this.peers.values()]) {
      if (peer.owner !== owner) continue;
      if (peer.kind === "native") peer.drop("Left the room");
      else {
        jsonPeer(peer, { t: "disconnect" });
        this.depart(peer, "Left the room");
        peer.ws.close(1000, "Left the room");
      }
    }
    if (!this.peers.size && !this.reservations.size)
      this.close("The last player left");
    else this.lobby();
  }

  resumeGame(peer) {
    if (this.disconnectPause) {
      this.resumeDisconnectedPlayers();
      return;
    }
    if (
      !this.running ||
      this.starting ||
      this.paused ||
      peer.playing ||
      peer.resumeId ||
      this.seats[peer.player] === null
    )
      return;
    if (
      peer.kind === "web"
        ? peer.gameClosed || !peer.contentReady || !peer.resumeAllowed
        : !this.manifest.nativeAuthority ||
          !peer.ready ||
          peer.bootstrapping ||
          peer.restarting
    )
      return;
    if (!this.canUseGame(peer)) {
      this.ownershipWaiting(peer);
      return;
    }
    if (!this.matchesGameCartridge(peer)) {
      this.cartridgeWaiting(peer);
      return;
    }
    peer.cartridgeNotice = false;
    if (
      peer.kind === "web" &&
      this.seats[peer.player] !== this.gameSeats?.[peer.player]
    ) {
      jsonPeer(peer, {
        t: "action-error",
        message: "Choose your previous player number to resume this game.",
      });
      return;
    }
    const active = [...this.peers.values()].filter((other) => other.playing);
    const preferredSource = this.manifest.nativeAuthority
      ? active.find(
          (other) =>
            other.player === this.host &&
            other.kind === "native" &&
            !other.restartSourceRequested &&
            !other.resumeSourceId &&
            !other.checkpointRelay &&
            !other.checkpointRequested,
        )
      : undefined;
    const source =
      preferredSource ??
      active.find((other) => other.kind === "web") ??
      active.find(
        (other) =>
          other.kind === "native" &&
          !other.checkpointRequested &&
          !other.checkpointRelay &&
          !other.resumeSourceId &&
          !other.restartSourceRequested,
      );
    if (!source && peer.kind === "native") return;
    if (!source) {
      jsonPeer(peer, {
        t: "action-error",
        message:
          "Waiting for an active player to provide the game state. Try opening the game window again shortly.",
      });
      return;
    }
    const request = { id: token(), peer, source, generation: this.generation };
    peer.resumeId = request.id;
    request.timer = setTimeout(
      () =>
        this.cancelResume(
          request,
          "The current game state timed out. Open the game window to try again.",
        ),
      10000,
    );
    request.timer.unref();
    this.resumes.set(request.id, request);
    if (source.kind === "web")
      jsonPeer(source, { t: "resume-source", id: request.id });
    else source.requestResumeSource(request.id);
  }

  matchesGameCartridge(peer) {
    if (!this.manifest.cartridges || this.manifest.system === "snes")
      return true;
    const cartridge = this.manifest.cartridges[this.seats[peer.player]];
    return (
      !!cartridge &&
      (peer.cartridge
        ? peer.cartridge.sha256 === cartridge.sha256
        : !peer.romId || peer.romId === cartridge.romId)
    );
  }

  cartridgeWaiting(peer) {
    if (peer.cartridgeNotice) return;
    peer.cartridgeNotice = true;
    jsonPeer(this.controllers.get(peer.player) ?? peer, {
      t: "action-error",
      message:
        "Your cartridge is ready for the next game. Wait in the room for the host to prepare a new game.",
    });
  }

  startingPeers() {
    return [...this.peers.values()].filter(
      (peer) => !this.startPlayers || this.startPlayers.has(peer.player),
    );
  }

  cancelResume(request, message) {
    if (!this.resumes.delete(request.id)) return;
    clearTimeout(request.timer);
    request.peer.resumeId = null;
    if (request.autoResume && this.disconnectPause) {
      this.disconnectPause.recovering = false;
      this.setPaused(true, null, true);
    }
    if (message) jsonPeer(request.peer, { t: "action-error", message });
  }

  completeResume(source, id, frame, state) {
    const request = this.resumes.get(id);
    if (!request || request.source !== source) return;
    const target = request.peer;
    if (
      request.generation !== this.generation ||
      this.peers.get(target.player) !== target ||
      !this.canUseGame(target) ||
      !this.canUseGame(source)
    ) {
      this.cancelResume(request);
      return;
    }
    if (request.autoResume) {
      const targets = request.targets;
      if (
        !targets.every((peer) => this.canResumeDisconnected(peer)) ||
        this.peers.get(source.player) !== source ||
        !source.playing
      ) {
        this.cancelResume(request);
        return;
      }
      this.disconnectPause = null;
      this.cancelResume(request);
      for (const peer of this.peers.values())
        if (peer.kind === "native" && peer.playing) peer.setRoomPaused(false);
      this.starting = true;
      this.prepareGame(state, target, targets.slice(1));
      return;
    }
    if (
      target.kind === "native" ||
      (source.kind === "native" && this.manifest.nativeAuthority)
    ) {
      // Native snapshots rebase rollback history; all active peers need that boundary.
      this.cancelResume(request);
      if (
        !this.running ||
        this.starting ||
        this.paused ||
        this.peers.get(target.player) !== target ||
        (target.kind === "native"
          ? !target.ready
          : target.gameClosed ||
            !target.contentReady ||
            !target.resumeAllowed) ||
        !this.matchesGameCartridge(target)
      )
        return;
      this.bridge.log(
        target.kind === "native" ? "native-auto-join" : "web-native-join",
        {
          room: this.id,
          player: target.player,
          sourcePlayer: source.player,
          sourceKind: source.kind,
          frame,
          generation: this.generation,
        },
      );
      this.starting = true;
      this.prepareGame(state, target);
      return;
    }
    const inputs = [];
    let nextInput;
    for (let player = 0; player < this.manifest.players; player++) {
      const peer = this.peers.get(player);
      const end = peer?.playing ? peer.nextFrame : this.vacant.get(player);
      if (!uint(frame) || !uint(end) || end < frame || end - frame > 600) {
        this.cancelResume(
          request,
          "The game advanced beyond the saved state. Open the game window to try again.",
        );
        return;
      }
      for (let f = frame; f < end; f++) {
        const b = this.inputHistory[player].get(f);
        if (b === undefined) {
          this.cancelResume(
            request,
            "The game input history expired. Open the game window to try again.",
          );
          return;
        }
        inputs.push({ player, f, b });
      }
      if (player === target.player) nextInput = end;
    }
    this.cancelResume(request);
    target.frame = target.confirmed = frame;
    target.nextFrame = nextInput;
    target.lastCheckpoint = Math.floor(frame / 60) * 60;
    target.playing = true;
    this.vacant.delete(target.player);
    this.detached.delete(target.player);
    this.bridge.log("web-resumed", {
      room: this.id,
      player: target.player,
      sourcePlayer: source.player,
      sourceKind: source.kind,
      frame,
      sourceNextFrame: source.nextFrame,
      localNextFrame: nextInput,
      queuedInputs: inputs.length,
      generation: this.generation,
    });
    jsonPeer(target, {
      t: "resume",
      f: frame,
      size: state.length,
      inputs,
      seats: this.gameSeats,
      generation: this.generation,
    });
    binaryPeer(target, state);
    this.electHost();
    this.lobby();
  }

  prepareGame(source, joiningPeer = null, additionalPeers = []) {
    if (this.needsNewGame() && !joiningPeer) {
      this.starting = false;
      this.lobby();
      return;
    }
    if (
      joiningPeer &&
      [joiningPeer, ...additionalPeers].some((peer) => !this.canUseGame(peer))
    )
      return;
    this.bindGameOwners();
    for (const request of [...this.resumes.values()])
      this.cancelResume(request);
    const restarting = this.started;
    this.startPlayers = new Set(
      [...this.peers.values()]
        .filter(
          (peer) =>
            !joiningPeer ||
            peer.playing ||
            peer === joiningPeer ||
            additionalPeers.includes(peer),
        )
        .map((peer) => peer.player),
    );
    const nativeState =
      !!joiningPeer ||
      (this.manifest.nativeAuthority &&
        this.peers.get(this.host)?.kind === "native");
    if (nativeState) {
      if (!source?.length || source.length > MAX_STATE)
        throw new Error("Native host did not provide a valid initial state");
      for (const peer of this.startingPeers())
        if (peer.kind === "web" && peer.contentSize !== source.length)
          throw new Error("Prepared core state sizes differ");
      this.state = Buffer.from(source);
      this.manifest.stateSize = source.length;
      this.sram = Buffer.alloc(0);
      this.revision++;
    }
    const gameSeats = this.seats.slice();
    const used = new Set(gameSeats.filter((seat) => seat !== null));
    for (let player = 0; player < this.manifest.players; player++) {
      if (gameSeats[player] !== null) continue;
      const seat = Array.from(
        { length: this.manifest.players },
        (_, index) => index,
      ).find((value) => !used.has(value));
      gameSeats[player] = seat;
      used.add(seat);
    }
    this.generation++;
    for (const player of this.startPlayers) this.detached.delete(player);
    this.bridge.log("game-starting", {
      room: this.id,
      generation: this.generation,
      restarting,
    });
    this.gameSeats = gameSeats;
    for (const history of this.inputHistory) history.clear();
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
        .filter((player) => !this.startPlayers.has(player))
        .map((player) => [player, 0]),
    );
    if (source && !nativeState) {
      const host = this.peers.get(this.host);
      jsonPeer(host, { t: "restart-source", size: source.length });
      binaryPeer(host, source);
    }
    for (const other of this.startingPeers()) {
      other.nextFrame = other.frame = other.confirmed = 0;
      other.lastCheckpoint = 0;
      if (other.kind === "web") {
        other.ready = -1;
        other.battery = nativeState || other.player === this.host;
        if (!nativeState && other.player !== this.host)
          this.pendingBatteries.add(other.player);
      } else {
        if (
          !nativeState &&
          !other.playing &&
          other.initialBattery !== undefined
        )
          this.pendingBatteries.add(other.player);
        if (other.playing) other.prepareRestart();
      }
    }
    this.lobby();
    for (const other of this.startingPeers())
      jsonPeer(other, {
        t: "prepare",
        seats: this.gameSeats,
        host: this.host,
        generation: this.generation,
        restarting,
        ...(nativeState ? { nativeState: true } : {}),
      });
    if (nativeState) {
      for (const peer of this.startingPeers())
        if (peer.kind === "web") this.sendWebState(peer, 0);
      this.maybeStart();
      return;
    }
    const hostPeer = this.peers.get(this.host);
    for (const other of this.peers.values()) {
      if (other.kind !== "native" || !this.pendingBatteries.has(other.player))
        continue;
      jsonPeer(hostPeer, {
        t: "battery",
        player: other.player,
        size: other.initialBattery.length,
      });
      binaryPeer(hostPeer, other.initialBattery);
      other.initialBattery = undefined;
    }
  }

  attach(ws, slot, reservation, manualJoin = false, retainRoom = false) {
    this.reservations.delete(slot);
    const peer = {
      kind: "web",
      player: slot,
      nickname: reservation.nickname,
      owner: reservation.owner,
      saveAllowed: reservation.saveAllowed,
      identity: reservation.credential,
      romId: reservation.romId,
      cartridge: reservation.cartridge,
      contentReady: !this.manifest.collectCartridges,
      contentSize: this.manifest.collectCartridges
        ? undefined
        : this.manifest.stateSize,
      ws,
      nextFrame: 0,
      ready: -1,
      battery: slot === 0,
      transfer: null,
      frame: 0,
      confirmed: 0,
      playing: false,
      initialBattery: Buffer.alloc(0),
      joinRequired: this.manifest.manualStart && manualJoin,
      retainRoom: this.manifest.manualStart && retainRoom,
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
      serverSaves: this.saveStatus().enabled,
      inputProfile: this.manifest.inputProfile,
      ...(this.manifest.manualStart
        ? {
            manualStart: true,
            nativeAuthority: this.manifest.nativeAuthority,
            ...(peer.joinRequired ? { manualJoin: true } : {}),
            host: this.host,
            generation: this.generation,
            running: !!this.running,
            collectCartridges: this.manifest.collectCartridges,
          }
        : {}),
    });
    ws.on("message", (bytes, binary) => {
      const controlling = this.controllers.get(slot) === peer;
      if (this.closed || (this.peers.get(slot) !== peer && !controlling))
        return;
      try {
        if (controlling) {
          if (binary || bytes.length > MAX_JSON)
            throw new Error("Invalid room control message");
          const data = JSON.parse(bytes.toString());
          if (data.t === "pong") this.pong(peer, data.nonce);
          else if (
            ["assign", "start-request", "kick", "disconnect-policy"].includes(
              data.t,
            )
          )
            this.control(peer, data);
          return;
        }
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
    const disconnected = () => {
      if (this.controllers.get(slot) === peer) this.leaveOwner(peer.owner);
      else this.depart(peer, "Web peer disconnected");
    };
    ws.on("error", disconnected);
    ws.on("close", disconnected);
    if (slot && this.state && !this.manifest.manualStart)
      this.sendWebState(peer, 0);
    this.lobby();
    if (
      this.manifest.collectCartridges &&
      this.contentPrepared &&
      this.canUseGame(peer) &&
      (!this.running ||
        (this.seats[slot] !== null && this.matchesGameCartridge(peer)))
    )
      this.sendContent(peer);
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
        if (["state", "battery", "save-state", "resume-state"].includes(data.t))
          peer.transfer = { ...data, discard: true };
        return;
      }
      throw new Error("Invalid room generation");
    }
    if (
      !this.canUseGame(peer) &&
      [
        "state",
        "battery",
        "ready",
        "content-ready",
        "native-ready",
        "input",
        "progress",
        "crc",
        "pause",
      ].includes(data.t)
    ) {
      if (["state", "battery", "save-state", "resume-state"].includes(data.t))
        peer.transfer = { ...data, discard: true };
      this.ownershipWaiting(peer);
      return;
    }
    switch (data.t) {
      case "seed-battery":
        if (!this.manifest.nativeAuthority || this.starting || this.running)
          return;
        peer.initialBattery = decodeBattery(data.battery);
        return;
      case "assign":
      case "start-request":
      case "kick":
      case "disconnect-policy":
        this.control(peer, data);
        return;
      case "game-close":
        this.closeGame(peer);
        return;
      case "game-open":
        this.openGame(peer);
        return;
      case "resume-state": {
        const request =
          this.resumes.get(data.id) ??
          (this.saveRequest?.id === data.id ? this.saveRequest : null);
        if (
          !uint(data.f) ||
          data.size !== this.manifest.stateSize ||
          (request && request.source !== peer)
        )
          throw new Error("Invalid resume source");
        peer.transfer = { ...data, discard: !request };
        return;
      }
      case "save-state":
        if (
          !peer.playing ||
          !this.canUseGame(peer) ||
          !uint(data.f) ||
          data.size !== this.manifest.stateSize ||
          typeof data.id !== "string" ||
          data.id.length > 64
        )
          throw new Error("Invalid save snapshot");
        peer.transfer = { ...data };
        return;
      case "content-ready":
        if (
          (!this.manifest.collectCartridges && !peer.reloading) ||
          !this.contentPrepared ||
          peer.contentReady ||
          !Number.isInteger(data.size) ||
          data.size < 1 ||
          data.size > MAX_STATE ||
          data.contentCrc !== this.manifest.contentCrc
        )
          throw new Error("Invalid prepared cartridge state");
        peer.contentReady = true;
        if (data.resume === true) peer.resumeAllowed = true;
        peer.reloading = false;
        peer.contentSize = data.size;
        if (
          [...this.peers.values()].some(
            (other) => other.contentReady && other.contentSize !== data.size,
          )
        )
          throw new Error("Prepared core state sizes differ");
        this.manifest.stateSize = data.size;
        this.lobby();
        this.resumeGame(peer);
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
          // Use fresh host progress, never a stale frame sampled when native
          // input arrives while the browser is paused or not advancing.
          for (const other of this.peers.values())
            if (other.kind === "native") other.pace(peer);
          this.publishClock(peer);
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
      !this.canUseGame(peer) ||
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
    if (transfer.t === "resume-state") {
      if (this.saveRequest?.id === transfer.id) {
        const request = this.saveRequest;
        this.saveRequest = null;
        clearTimeout(request.timer);
        if (request.generation === this.generation && request.source === peer)
          void this.captureSaves(peer, transfer.f, bytes).catch((error) =>
            this.saveFailed(error),
          );
        return;
      }
      this.completeResume(peer, transfer.id, transfer.f, bytes);
      return;
    }
    if (transfer.t === "save-state") {
      void this.captureSaves(peer, transfer.f, bytes)
        .then(
          () => ({ t: "save-stored", id: transfer.id }),
          (error) => {
            this.saveFailed(error);
            return { t: "save-stored", id: transfer.id, error: error.message };
          },
        )
        .then((reply) => {
          try {
            jsonPeer(peer, reply);
          } catch {
            // The client may have closed or congested while the disk was busy.
          }
        });
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
    if (!this.canUseGame(peer)) return;
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
    for (const peer of this.startingPeers()) {
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
    for (const peer of this.startingPeers())
      if (peer.kind === "native") peer.start();
    this.finishStart();
  }

  finishStart() {
    if (this.running) return;
    for (const peer of this.startingPeers())
      if (
        peer.kind === "native" &&
        (!peer.bootstrapped || (peer.calibration && !peer.calibrated))
      )
        return;
    this.running = true;
    this.starting = false;
    this.bridge.log("game-started", {
      room: this.id,
      generation: this.generation,
    });
    this.nativeClockAt = performance.now();
    for (const peer of this.startingPeers()) {
      peer.playing = true;
      this.disconnectedPlayers.delete(peer.player);
    }
    this.electHost();
    for (const peer of this.startingPeers())
      if (peer.kind === "native") peer.finishStart();
    for (const peer of this.startingPeers())
      jsonPeer(peer, {
        t: "start",
        f: 0,
        player: peer.player,
        players: this.manifest.players,
        maxPrediction: this.manifest.maxPrediction,
        ...(this.manifest.manualStart ? { generation: this.generation } : {}),
      });
    for (const peer of this.startingPeers())
      if (peer.kind === "native") peer.flushInputs?.();
    this.startPlayers = null;
    if (this.manualPaused) this.setPaused(true);
    this.pauseForDisconnect();
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
    if (this.manifest.inputProfile && buttons & CABLE_INPUT)
      throw new Error("Cable control input is reserved for the broker");
    if (frame > this.progress + 120)
      throw new Error("Input exceeds host frame window");
    peer.nextFrame++;
    if (
      this.manifest.nativeAuthority &&
      this.peers.get(this.host)?.kind === "native"
    ) {
      const host = this.peers.get(this.host);
      host.frame = Math.max(0, host.lastReportedFrame - host.frameOffset);
      host.confirmed = Math.min(
        host.frame,
        ...[...this.peers.values()]
          .filter((other) => other.playing)
          .map((other) => other.nextFrame),
      );
      this.progress = host.frame;
      this.confirmed = host.confirmed;
      const reference = this.nativePacingReference();
      for (const other of this.peers.values())
        if (other.kind === "native") other.pace(reference);
      if (peer === host) this.publishClock(host);
      if (
        peer === host &&
        host.frame > 0 &&
        host.frame % 600 === 0 &&
        this.saveHost() === null
      )
        host.requestCheckpoint();
    } else if (
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

  nativePacingReference() {
    const host = this.peers.get(this.host);
    const active = [...this.peers.values()].filter((peer) => peer.playing);
    if (!host?.playing || active.some((peer) => peer.kind !== "native")) {
      this.nativePacingSource = null;
      return host;
    }
    const slowest = active.reduce(
      (source, peer) => (peer.frame < source.frame ? peer : source),
      host,
    );
    const previous = this.nativePacingSource;
    // Do not switch references on ordinary packet ordering or a one-frame tie.
    // A software-paced peer cannot catch a host that keeps advancing equally fast.
    if (
      !active.includes(previous) ||
      previous.frame - slowest.frame > PACING_LEAD
    )
      this.nativePacingSource = slowest;
    return this.nativePacingSource;
  }

  publishClock(host) {
    if (
      !this.running ||
      this.paused ||
      !host?.playing ||
      host.player !== this.host
    )
      return;
    if (
      this.lastClock?.host === host &&
      this.lastClock.generation === this.generation &&
      host.frame < this.lastClock.frame + 6
    )
      return;
    this.lastClock = { host, generation: this.generation, frame: host.frame };
    const packet = {
      t: "clock",
      host: host.player,
      f: host.frame,
      generation: this.generation,
    };
    for (const peer of this.peers.values())
      if (peer !== host && peer.playing) jsonPeer(peer, packet);
  }

  relayInput(peer, frame, buttons) {
    const history = this.inputHistory[peer.player];
    history.set(frame, buttons);
    while (history.size > 600) history.delete(history.keys().next().value);
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
    const checkpointHost = this.manifest.nativeAuthority
      ? this.saveHost()
      : this.host;
    const host = checks.get(checkpointHost);
    if (host !== undefined) {
      for (const value of checks.values())
        if (value !== host)
          throw new Error(`State mismatch at frame ${data.f}`);
      if (peer.player === checkpointHost)
        for (const other of this.peers.values())
          // Private waiting frames cannot verify the running game.
          if (other.kind === "native" && other.playing)
            other.sendCrc(data.f, data.crc);
    }
    for (const frame of this.crcs.keys())
      if (frame < this.latestCheckpoint - 600) this.crcs.delete(frame);
  }

  nativeCheckpoint(peer, frame, state, generation = this.generation) {
    if (
      !this.running ||
      generation !== this.generation ||
      peer.player !== this.host ||
      !uint(frame) ||
      frame > peer.nextFrame ||
      frame < this.progress - 600
    )
      return;
    if (this.saveStatus().enabled)
      void this.captureSaves(peer, frame, state).catch((error) =>
        this.saveFailed(error),
      );
    this.bridge.log("native-checkpoint", {
      room: this.id,
      player: peer.player,
      frame,
      generation: this.generation,
    });
    return true;
  }

  requestState() {
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
    if (this.manifest.manualStart && (!this.running || !peer.playing)) {
      this.bridge.log("game-pause-ignored", {
        room: this.id,
        player: peer.player,
        kind: peer.kind,
        paused,
        running: !!this.running,
        starting: !!this.starting,
        playing: !!peer.playing,
        generation: this.generation,
      });
      return;
    }
    if (!this.started) throw new Error("Pause requested before start");
    if (this.disconnectPause?.recovering && !paused) return;
    this.manualPaused = paused;
    this.setPaused(
      paused || !!this.disconnectPause,
      peer,
      !!this.disconnectPause,
    );
    if (!this.paused)
      for (const other of this.peers.values()) this.resumeGame(other);
  }

  setPaused(paused, origin = null, force = false) {
    if (this.paused === paused && !force) return;
    this.paused = paused;
    this.bridge.log("game-pause", {
      room: this.id,
      paused,
      frame: this.progress,
      automatic: !!this.disconnectPause,
    });
    for (const peer of this.peers.values()) {
      if (!peer.playing) continue;
      if (peer.kind === "native") {
        if (peer.probe) {
          if (paused) {
            peer.probe.suspended = true;
            delete peer.probe.resumedAt;
          } else if (peer.probe.suspended) peer.probe.resumedAt = performance.now();
        }
        if (this.disconnectPause) {
          peer.setRoomPaused(paused);
          continue;
        }
        if (peer !== origin || force)
          peer.send(
            paused ? CMD.PAUSE : CMD.RESUME,
            paused ? fixedString("Waiting for player") : undefined,
          );
      } else jsonPeer(peer, { t: "pause", paused });
    }
  }

  pauseForDisconnect() {
    if (
      !this.running ||
      ![...this.peers.values()].some((peer) => peer.playing)
    ) {
      this.disconnectPause = null;
      return;
    }
    if (
      this.manifest.disconnectPolicy !== "pause" ||
      !this.disconnectedPlayers.size
    )
      return;
    this.disconnectPause ??= { recovering: false };
    if (!this.disconnectPause.recovering) this.setPaused(true);
  }

  canResumeDisconnected(peer) {
    return (
      peer &&
      this.peers.get(peer.player) === peer &&
      !peer.playing &&
      this.seats[peer.player] === this.gameSeats?.[peer.player] &&
      this.canUseGame(peer) &&
      this.matchesGameCartridge(peer) &&
      (peer.kind === "native"
        ? peer.ready && !peer.bootstrapping && !peer.restarting
        : !peer.gameClosed && peer.contentReady && peer.resumeAllowed)
    );
  }

  resumeDisconnectedPlayers() {
    if (
      !this.disconnectPause ||
      this.disconnectPause.recovering ||
      !this.running ||
      this.starting
    )
      return;
    const targets = [...this.disconnectedPlayers].map((player) =>
      this.peers.get(player),
    );
    if (
      !targets.length ||
      !targets.every((peer) => this.canResumeDisconnected(peer))
    )
      return;
    const active = [...this.peers.values()].filter(
      (peer) =>
        peer.playing &&
        !peer.checkpointRelay &&
        !peer.resumeSourceId &&
        !peer.restartSourceRequested,
    );
    const source =
      active.find((peer) => peer.player === this.host) ?? active[0];
    if (!source) return;
    const request = {
      id: token(),
      peer: targets[0],
      targets,
      source,
      generation: this.generation,
      autoResume: true,
    };
    this.disconnectPause.recovering = true;
    request.peer.resumeId = request.id;
    this.resumes.set(request.id, request);
    request.timer = setTimeout(
      () =>
        this.cancelResume(
          request,
          "Could not synchronize the paused game. Try joining again.",
        ),
      10000,
    );
    request.timer.unref();
    if (source.kind === "native") {
      // RetroArch serves snapshots in its frame loop, so release only the source.
      this.paused = false;
      source.setRoomPaused(false);
      source.requestResumeSource(request.id);
    } else jsonPeer(source, { t: "resume-source", id: request.id });
  }

  notify(message) {
    try {
      for (const peer of this.peers.values()) jsonPeer(peer, message);
      if (["lobby", "latency", "peer-error", "peer-left"].includes(message.t))
        for (const controller of this.controllers.values())
          jsonPeer(controller, message);
    } catch (error) {
      this.close(error.message);
    }
  }

  electHost() {
    if (this.manifest.nativeAuthority) {
      const members = [
        ...this.peers.values(),
        ...[...this.reservations]
          .filter(([, member]) => member.kind === "native")
          .map(([player, member]) => ({ ...member, player })),
      ];
      const active = this.running
        ? members.filter((member) => member.playing)
        : [];
      const candidates = active.length ? active : members;
      const natives = candidates.filter((member) => member.kind === "native");
      const preferred = natives.length ? natives : candidates;
      const next =
        preferred.find((member) => member.player === this.host) ??
        preferred.sort((a, b) => a.player - b.player)[0];
      if (this.host !== (next?.player ?? null))
        this.bridge.log("host-changed", {
          room: this.id,
          previous: this.host,
          host: next?.player ?? null,
          kind: next?.kind ?? null,
        });
      this.host = next?.player ?? null;
      this.manifest.owner = next?.owner ?? "";
      if (next?.playing) {
        this.progress =
          next.kind === "native"
            ? Math.max(0, next.lastReportedFrame - next.frameOffset)
            : next.frame;
        this.confirmed =
          next.kind === "native"
            ? Math.min(
                this.progress,
                ...members
                  .filter((member) => member.playing)
                  .map((member) => member.nextFrame),
              )
            : next.confirmed;
      }
      return;
    }
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
        this.relayInput(
          { player },
          frame,
          this.detached.has(player) ? CABLE_INPUT : 0,
        );
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
    const reserved = this.reservations.size;
    this.expireReservations();
    if (reserved !== this.reservations.size) this.lobby();
    if (!this.peers.size && !this.reservations.size) {
      this.close("No players connected");
      return;
    }
    const now = performance.now();
    if (
      !this.paused &&
      Date.now() - this.lastSaveCapture >=
        this.bridge.admin.settings.saveIntervalSeconds * 1000
    ) {
      try {
        this.requestSave();
      } catch (error) {
        clearTimeout(this.saveRequest?.timer);
        this.saveRequest = null;
        this.saveFailed(error);
      }
    }
    for (const peer of [...this.peers.values(), ...this.controllers.values()]) {
      if (peer.kind === "native" && (peer.phase !== "connected" || !peer.ready))
        continue;
      if (peer.kind === "native" && this.paused) {
        // RetroArch can stop servicing PING while its frontend is paused.
        // Retain the ordered PONG for restart barriers, excluding paused time.
        if (peer.probe) peer.probe.suspended = true;
        continue;
      }
      if (peer.probe) {
        if (peer.probe.suspended) peer.probe.resumedAt ??= now;
        const elapsed = now - (peer.probe.resumedAt ?? peer.probe.sent);
        if (elapsed > 6000) peer.ping = null;
        if (elapsed > 15000) {
          if (peer.kind === "native") peer.drop("Native heartbeat timed out");
          else peer.ws.terminate();
        }
        continue;
      }
      peer.probe = { sent: now, nonce: token() };
      try {
        if (peer.kind === "native") {
          peer.keepLobbyAlive();
          peer.send(CMD.PING);
        } else jsonPeer(peer, { t: "ping", nonce: peer.probe.nonce });
      } catch {
        if (peer.kind === "native") peer.close();
        else peer.ws.terminate();
      }
    }
    this.publishPings();
    this.logTiming();
    for (const peer of this.peers.values())
      if (peer.kind === "native" || this.disconnectPause) this.resumeGame(peer);
  }

  pong(peer, nonce) {
    if (!peer.probe || (peer.kind === "web" && peer.probe.nonce !== nonce))
      return;
    if (!peer.probe.suspended) {
      const sample = performance.now() - peer.probe.sent;
      peer.ping = Math.round(
        peer.ping === null || peer.ping === undefined
          ? sample
          : peer.ping * 0.7 + sample * 0.3,
      );
    }
    peer.probe = null;
    this.publishPings();
  }

  logTiming() {
    if (!this.running) return;
    const host = this.peers.get(this.host);
    if (!host?.playing) return;
    const hostFrame =
      host.kind === "native"
        ? Math.max(0, host.lastReportedFrame - host.frameOffset)
        : host.frame;
    for (const peer of this.peers.values()) {
      if (!peer.playing) continue;
      const inputFrame =
        peer.kind === "native"
          ? Math.max(0, peer.lastReportedFrame - peer.frameOffset)
          : Math.max(0, peer.nextFrame - 1);
      this.bridge.log("game-timing", {
        room: this.id,
        generation: this.generation,
        player: peer.player,
        kind: peer.kind,
        host: this.host,
        hostKind: host.kind,
        hostFrame,
        inputFrame,
        inputLeadFrames: inputFrame - hostFrame,
        pingMs: peer.ping ?? null,
        hostPingMs: host.ping ?? null,
        paused: !!this.paused,
        queuedBytes:
          peer.kind === "native"
            ? peer.socket.writableLength
            : peer.ws.bufferedAmount,
      });
    }
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

  detachCable(player, frame) {
    if (
      this.closed ||
      !this.manifest.inputProfile ||
      !this.hadGame ||
      this.detached.has(player)
    )
      return;
    this.detached.add(player);
    this.bridge.log("cable-detached", {
      room: this.id,
      player,
      seat: this.gameSeats?.[player],
      generation: this.generation,
      frame:
        this.vacant.get(player) ??
        frame ??
        this.peers.get(player)?.nextFrame ??
        0,
    });
  }

  depart(peer, message) {
    if (this.closed || this.peers.get(peer.player) !== peer) return;
    for (const request of [...this.resumes.values()])
      if (request.peer === peer || request.source === peer)
        this.cancelResume(request);
    this.loadingContent = false;
    this.peers.delete(peer.player);
    if (this.lastClock?.host === peer) this.lastClock = null;
    this.pendingBatteries.delete(peer.player);
    const returned =
      peer.kind === "native" && this.returnController(peer.player);
    if (!returned) this.detachCable(peer.player, peer.nextFrame);
    if (this.manifest.manualStart) {
      if (!this.peers.size && !this.reservations.size) {
        this.close("The last player left");
        return;
      }
      const wasHost = peer.player === this.host;
      if (peer.playing && this.running) {
        this.vacant.set(peer.player, peer.nextFrame);
        this.disconnectedPlayers.add(peer.player);
      }
      if (!returned && this.reservations.get(peer.player)?.kind !== "native")
        this.seats[peer.player] = null;
      if (
        returned &&
        ![...this.peers.values()].some((other) => other.playing)
      ) {
        this.started = this.running = this.starting = false;
        this.paused = false;
      }
      this.electHost();
      if (!returned)
        this.notify({ t: "peer-left", player: peer.player, message });
      if (this.starting && wasHost && this.host !== null) this.beginStart();
      else if (this.starting) this.maybeStart();
      this.pauseForDisconnect();
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
    clearTimeout(this.saveRequest?.timer);
    this.saveRequest = null;
    for (const player of this.controllers.keys())
      this.removeController(player, message);
    for (const request of [...this.resumes.values()])
      this.cancelResume(request);
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
    for (const peer of this.pendingNative) peer.close();
    this.pendingNative.clear();
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
  saveDirectory = null,
  allowedOrigins = [],
  logger = (entry) => console.info(JSON.stringify(entry)),
} = {}) {
  if (typeof adminToken !== "string" || adminToken.length < 24)
    throw new Error("Bridge admin token must contain at least 24 characters");
  const rooms = new Map();
  const admin = await new BridgeAdmin(saveDirectory, maxRooms).init();
  const bridge = {
    rooms,
    admin,
    saves: saveDirectory ? await new SaveOutbox(saveDirectory).init() : null,
    log(event, fields = {}) {
      const entry = { time: new Date().toISOString(), event, ...fields };
      admin.record(entry);
      logger(entry);
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
      if (path.startsWith("/v1/rooms/admin/ui/") && request.method === "GET") {
        const name = path.slice("/v1/rooms/admin/ui/".length) || "index.html";
        const asset = await adminAsset(name);
        if (!asset) return reply(404, { error: "Admin asset not found" });
        response.writeHead(200, {
          "Content-Type": asset.contentType,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        return response.end(asset.body);
      }
      if (path === "/v1/rooms/admin" && request.method === "GET")
        return reply(
          200,
          admin.status(bridge, {
            httpPort: http.address().port,
            nativePortStart: portStart,
            nativePortEnd: portEnd,
            allowedOrigins,
          }),
        );
      if (path === "/v1/rooms/admin/logs" && request.method === "GET") {
        const after = Number(
          new URL(request.url, "http://bridge").searchParams.get("after") ?? 0,
        );
        if (!Number.isSafeInteger(after) || after < 0)
          return reply(400, { error: "Invalid log cursor" });
        return reply(200, admin.logs(after));
      }
      if (path === "/v1/rooms/admin/settings" && request.method === "PUT") {
        const settings = await admin.update(await body(request));
        bridge.log("admin-settings-updated", settings);
        return reply(200, settings);
      }
      if (path === "/v1/rooms/save-queue" && request.method === "GET")
        return reply(
          200,
          bridge.saves?.list(
            new URL(request.url, "http://bridge").searchParams.get("room"),
          ) ?? [],
        );
      const saved = path.match(/^\/v1\/rooms\/save-queue\/([a-f0-9]{64})$/);
      if (saved && request.method === "POST") {
        const data = await body(request);
        const entry = bridge.saves?.entries.get(saved[1]);
        const acknowledged = await bridge.saves?.acknowledge(
          saved[1],
          data.revision,
          data.error,
        );
        const room = entry && rooms.get(entry.roomId);
        if (room && acknowledged && !data.error) room.savesSynced = true;
        room?.publishSaveStatus();
        return reply(200, { acknowledged: !!acknowledged });
      }
      if (path === "/v1/rooms" && request.method === "GET")
        return reply(
          200,
          [...rooms.values()].map((room) => room.metadata()),
        );
      if (path === "/v1/rooms" && request.method === "POST") {
        if (!admin.settings.roomsEnabled)
          return reply(409, {
            error: "New rooms are disabled by the administrator",
          });
        if (rooms.size >= admin.settings.maxRooms)
          return reply(409, { error: "Room capacity reached" });
        const data = await body(request);
        const manifest = validateManifest(data);
        if (rooms.size >= admin.settings.maxRooms)
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
                (manifest.nativeAuth
                  ? room.pendingNative.size >= manifest.players
                  : slot < 0)
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
              const peer = new NativePeer(
                room,
                socket,
                manifest.nativeAuth ? -1 : slot,
              );
              if (manifest.nativeAuth) {
                room.pendingNative.add(peer);
                return;
              }
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
        const hostToken = room.reserve(0, manifest.owner, manifest.nickname, {
          romId: manifest.romId,
          saveAllowed: manifest.saveAllowed,
          cartridge: manifest.cartridges?.[0],
        });
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
      const match = path.match(
        /^\/v1\/rooms\/([A-Za-z0-9_-]+)(\/join|\/leave|\/control|\/native(?:\/[A-Za-z0-9_-]+)?)?$/,
      );
      const room = match && rooms.get(match[1]);
      if (!room) return reply(404, { error: "Room not found" });
      if (match[2] === "/control" && request.method === "POST") {
        const data = await body(request);
        const owner = boundedString(data.owner, "", 128);
        const member = [
          ...room.peers.values(),
          ...[...room.reservations].map(([player, item]) => ({
            ...item,
            player,
          })),
        ].find((item) => owner && item.owner === owner);
        if (!member)
          return reply(403, { error: "Join the room before controlling it" });
        if (
          !["start-request", "assign", "kick", "disconnect-policy"].includes(
            data.t,
          )
        )
          return reply(400, { error: "Invalid room action" });
        const error = room.control(member, data);
        if (error) return reply(409, { error });
        return reply(200, room.metadata());
      }
      if (match[2] === "/leave" && request.method === "POST") {
        const data = await body(request);
        const owner = boundedString(data.owner, "", 128);
        if (!owner) return reply(400, { error: "Account owner is required" });
        room.leaveOwner(owner);
        return reply(200, { left: true });
      }
      if (match[2]?.startsWith("/native/")) {
        const found = room.nativeReservation(match[2].slice(8));
        if (!found) return reply(404, { error: "Native preparation expired" });
        const { player, item } = found;
        if (request.method === "DELETE") {
          if (room.peers.has(player))
            return reply(409, { error: "Disconnect RetroArch first" });
          room.reservations.delete(player);
          if (!room.returnController(player)) {
            room.detachCable(player);
            room.seats[player] = null;
          }
          room.loadingContent = false;
          room.electHost();
          room.lobby();
          return reply(200, { cancelled: true });
        }
        if (request.method === "PATCH") {
          const data = await body(request);
          const error = room.assignSeat({ player }, player, data.seat);
          if (error) return reply(409, { error });
        } else if (request.method !== "GET")
          return reply(405, { error: "Method not allowed" });
        const candidate = { ...item, player };
        const pending =
          !room.contentPrepared ||
          !room.canUseGame(candidate) ||
          (room.running && !room.matchesGameCartridge(candidate)) ||
          (room.manifest.collectCartridges &&
            !room.state &&
            !room.manifest.nativeAuthority);
        return reply(200, {
          player,
          owner: item.owner,
          romId: item.romId,
          nickname: item.nickname,
          seat: room.seats[player],
          ready: !!item.ready,
          connected: room.peers.has(player),
          expiresAt: item.until,
          players: room.manifest.players,
          tcpPort: room.tcpPort,
          nativePassword: item.nativePassword ?? "",
          cartridges: room.manifest.cartridges,
          ...(room.manifest.nativeAuthority && !pending
            ? {
                initialBatteries: room.initialBatteries(),
                nativeAuthority: true,
              }
            : {}),
          coreName: room.manifest.coreName,
          coreVersion: room.manifest.coreVersion,
          running: !!room.running,
          pending,
        });
      }
      if (request.method === "DELETE" && !match[2]) {
        room.close();
        return reply(200, { closed: true });
      }
      if (
        request.method === "POST" &&
        ["/join", "/native"].includes(match[2])
      ) {
        const data = await body(request);
        if ((room.started && !room.manifest.manualStart) || room.starting)
          return reply(409, { error: "Room has started" });
        if (room.password && !secretEqual(data.password, room.password))
          return reply(403, { error: "Incorrect room password" });
        const native = match[2] === "/native";
        if (
          native &&
          (!room.manifest.nativeAuth || !room.manifest.nativeAllowed)
        )
          return reply(409, {
            error: "Create a room with native preparation enabled",
          });
        const owner = boundedString(data.owner, "", 128);
        if (room.removedOwners.has(owner))
          return reply(409, { error: "Removed from this room by the host" });
        const nickname = boundedString(data.nickname, "Web player", 31);
        const switching =
          native && owner
            ? [...room.peers.values()].find(
                (peer) => peer.owner === owner && peer.kind === "web",
              )
            : null;
        if (
          room.manifest.nativeAuth &&
          owner &&
          !switching &&
          [...room.peers.values(), ...room.reservations.values()].some(
            (member) => member.owner === owner,
          )
        )
          return reply(409, { error: "Account already joined this room" });
        const slot = switching?.player ?? room.available(native, owner);
        if (slot < 0) return reply(409, { error: "Room is full" });
        const romId = data.romId ?? room.manifest.romId;
        const cartridge = room.manifest.collectCartridges
          ? cartridgeDescription(data.cartridge ?? switching?.cartridge)
          : null;
        if (cartridge && cartridge.romId !== romId)
          return reply(400, {
            error: "Selected cartridge does not match the player",
          });
        if (
          room.contentPrepared &&
          !room.manifest.collectCartridges &&
          room.manifest.cartridges &&
          !room.manifest.cartridges.some((rom) => rom.romId === romId)
        )
          return reply(400, { error: "Cartridge is not in this room" });
        if (native) {
          if (!owner)
            return reply(400, {
              error: "Native preparation requires an account",
            });
          if (switching && switching.romId !== romId)
            return reply(409, {
              error: "Keep your selected cartridge when switching clients",
            });
          if (
            !switching &&
            room.members().some((member) => member.owner === owner)
          )
            return reply(409, { error: "Account already joined this room" });
          if (
            !room.manifest.nativeAuthority &&
            switching?.player === room.host &&
            ![...room.peers.values()].some(
              (peer) => peer !== switching && peer.kind === "web",
            )
          )
            return reply(409, {
              error: "Another browser host must remain connected",
            });
          if (
            !["windows-x86_64", "windows-x86", "windows-arm64"].includes(
              data.clientPlatform,
            )
          )
            return reply(400, {
              error: "Unsupported native launcher platform",
            });
          const initialBattery = decodeBattery(data.battery);
          if (
            !room.manifest.nativeAuthority &&
            room.manifest.system === "snes" &&
            initialBattery.length
          )
            return reply(400, {
              error: "SNES uses the host's shared cartridge save",
            });
          const nativePassword = token();
          const expiresAt = Date.now() + NATIVE_PREPARE_MS;
          if (switching?.retainRoom) room.closeGame(switching);
          const credential = room.reserve(slot, owner, nickname, {
            kind: "native",
            nativePassword,
            romId,
            initialBattery,
            saveAllowed:
              data.saveAllowed === true || switching?.saveAllowed === true,
            until: expiresAt,
            clientPlatform: data.clientPlatform,
            cartridge,
          });
          if (switching) {
            if (switching.retainRoom) {
              room.peers.delete(slot);
              room.controllers.set(slot, switching);
              jsonPeer(switching, { t: "handoff", retainRoom: true });
            } else {
              jsonPeer(switching, { t: "handoff" });
              room.depart(switching, "Continuing in RetroArch");
              switching.ws.close(1000, "Continuing in RetroArch");
            }
          }
          room.electHost();
          room.lobby();
          return reply(201, {
            id: room.id,
            player: slot,
            credential,
            nativePassword,
            expiresAt,
            tcpPort: room.tcpPort,
            players: room.manifest.players,
          });
        }
        const peerToken = room.reserve(slot, owner, nickname, {
          romId,
          saveAllowed: data.saveAllowed === true,
          cartridge,
        });
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
        reservation.kind === "native" ||
        (match[2] === "host" && slot !== 0) ||
        reservation.until < Date.now() ||
        !secretEqual(credential, reservation.credential)
      )
        continue;
      room.reservations.delete(slot);
      wss.handleUpgrade(request, socket, head, (ws) =>
        room.attach(
          ws,
          slot,
          reservation,
          url.searchParams.get("manualJoin") === "1",
          url.searchParams.get("retainRoom") === "1",
        ),
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
      await bridge.saves?.pending;
      await admin.pending;
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
    saveDirectory: process.env.NETPLAY_BRIDGE_SAVE_DIR || null,
  });
  console.info(`Netplay bridge listening on port ${service.address.port}`);
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, async () => {
      await service.close();
      process.exit(0);
    });
}
