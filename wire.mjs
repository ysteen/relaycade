import { deflateSync, inflateSync } from "node:zlib";

export const CMD = Object.freeze({
  ACK: 0,
  NAK: 1,
  DISCONNECT: 2,
  INPUT: 3,
  NOINPUT: 4,
  NICK: 0x20,
  PASSWORD: 0x21,
  INFO: 0x22,
  SYNC: 0x23,
  SPECTATE: 0x24,
  PLAY: 0x25,
  MODE: 0x26,
  MODE_REFUSED: 0x27,
  CRC: 0x40,
  REQUEST_STATE: 0x41,
  LOAD_STATE: 0x42,
  PAUSE: 0x43,
  RESUME: 0x44,
  STALL: 0x45,
  RESET: 0x46,
  CFG: 0x61,
  CFG_ACK: 0x62,
  CHAT: 0x1000,
  PING: 0x1100,
  PONG: 0x1101,
  ALLOW_PAUSING: 0x2000,
  LATENCY: 0x2001,
});
export const MAGIC = 0x52414e50;
export const MAX_STATE = 16 * 1024 * 1024;
export const MAX_PACKET = MAX_STATE + 1024;
export const NICK_SIZE = 32;
export const DEVICES = 16;
export const WASM_PLATFORM = (4 << 15) | 4;

export function words(...values) {
  const out = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => out.writeUInt32BE(value >>> 0, index * 4));
  return out;
}

export function fixedString(value, size = NICK_SIZE) {
  const out = Buffer.alloc(size);
  out.write(value, 0, size - 1, "utf8");
  return out;
}

export function readString(bytes) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString("utf8");
}

export function packet(command, payload = Buffer.alloc(0)) {
  return Buffer.concat([words(command, payload.length), payload]);
}

export function infoPayload(manifest) {
  return Buffer.concat([
    words(manifest.contentCrc),
    fixedString(manifest.coreName),
    fixedString(manifest.coreVersion),
  ]);
}

export function syncPayload(manifest, player, nickname, sram, hostSeat = 0) {
  const devices = Buffer.alloc(DEVICES * 4);
  for (let i = 0; i < manifest.players; i++) devices.writeUInt32BE(1, i * 4);
  const clients = Buffer.alloc(DEVICES * 4);
  clients.writeUInt32BE(1, hostSeat * 4);
  return Buffer.concat([
    words(0, player),
    devices,
    Buffer.alloc(DEVICES),
    clients,
    fixedString(nickname),
    sram,
  ]);
}

export function modePayload(
  frame,
  player,
  nickname,
  self = false,
  slave = false,
  seat = player,
) {
  return Buffer.concat([
    words(
      frame,
      (self ? 0xc0000000 : 0x40000000) | (slave ? 0x20000000 : 0) | player,
      1 << seat,
    ),
    Buffer.alloc(DEVICES),
    fixedString(nickname),
  ]);
}

export function wrapState(raw, protocol) {
  if (protocol < 7) return raw;
  const aligned = (raw.length + 7) & ~7;
  const out = Buffer.alloc(24 + aligned);
  out.write("NETPLAY", 0, "ascii");
  out[7] = 1;
  out.write("MEM ", 8, "ascii");
  out.writeUInt32LE(raw.length, 12);
  raw.copy(out, 16);
  out.write("END ", 16 + aligned, "ascii");
  return out;
}

export function statePayload(frame, raw, protocol, compressed) {
  const wrapped = wrapState(raw, protocol);
  return Buffer.concat([
    words(frame, wrapped.length),
    compressed ? deflateSync(wrapped) : wrapped,
  ]);
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes)
    value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export class Decoder {
  constructor(onHeader, onPacket) {
    this.onHeader = onHeader;
    this.onPacket = onPacket;
    this.buffer = Buffer.alloc(0);
    this.header = false;
  }

  push(chunk) {
    if (this.buffer.length + chunk.length > MAX_PACKET + 65536)
      throw new Error("Native receive queue exceeded");
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.header) {
      if (this.buffer.length < 24) return;
      const header = this.buffer.subarray(0, 24);
      this.buffer = this.buffer.subarray(24);
      this.header = true;
      this.onHeader(header);
    }
    while (this.buffer.length >= 8) {
      const command = this.buffer.readUInt32BE(0);
      const size = this.buffer.readUInt32BE(4);
      if (size > MAX_PACKET)
        throw new Error("Native packet exceeded maximum size");
      if (this.buffer.length < size + 8) return;
      const payload = this.buffer.subarray(8, size + 8);
      this.buffer = this.buffer.subarray(size + 8);
      this.onPacket(command, payload);
    }
  }
}

export function readStatePayload(payload, protocol, compressed, expectedSize) {
  if (payload.length < 8) throw new Error("Truncated native state");
  const size = payload.readUInt32BE(4);
  if (
    size < 1 ||
    size > MAX_STATE + 65536 ||
    (expectedSize !== undefined &&
      (size < expectedSize || size > expectedSize + 65536))
  )
    throw new Error("Unexpected native state size");
  const state = compressed
    ? inflateSync(payload.subarray(8), { maxOutputLength: size })
    : payload.subarray(8);
  if (state.length !== size) throw new Error("Truncated native state data");
  if (protocol < 7 || state.subarray(0, 7).toString() !== "NETPLAY") {
    if (
      state.length > MAX_STATE ||
      (expectedSize !== undefined && state.length !== expectedSize)
    )
      throw new Error("Unexpected raw core state size");
    return { frame: payload.readUInt32BE(0), state: Buffer.from(state) };
  }
  if (state[7] !== 1) throw new Error("Unsupported native state envelope");
  let core = null,
    ended = false;
  for (let offset = 8; offset + 8 <= state.length;) {
    const kind = state.subarray(offset, offset + 4).toString();
    const length = state.readUInt32LE(offset + 4);
    offset += 8;
    if (length > state.length - offset)
      throw new Error("Invalid native state block");
    if (kind === "END ") {
      if (length !== 0) throw new Error("Invalid state terminator");
      ended = true;
      break;
    }
    if (kind === "MEM ") {
      if (
        core ||
        !length ||
        length > MAX_STATE ||
        (expectedSize !== undefined && length !== expectedSize)
      )
        throw new Error("Invalid native core state block");
      core = Buffer.from(state.subarray(offset, offset + length));
    }
    offset += Math.ceil(length / 8) * 8;
  }
  if (!core || !ended) throw new Error("Incomplete native state envelope");
  return { frame: payload.readUInt32BE(0), state: core };
}
