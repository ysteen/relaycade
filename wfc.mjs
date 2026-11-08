import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { WebSocket, WebSocketServer } from "ws";

export const WFC_MAX_FRAME = 2048;
const QUEUE_LIMIT = 256 * 1024;
const TICKET_MS = 60_000;
const MAX_SESSIONS = 16;

export function publicIpv4(bytes) {
  const [a, b, c] = bytes;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 &&
      (b === 168 ||
        (b === 0 && (c === 0 || c === 2)) ||
        (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

export function allowedWfcFrame(frame) {
  if (frame.length < 42 || frame.length > WFC_MAX_FRAME) return false;
  const type = frame.readUInt16BE(12);
  if (type === 0x0806) {
    return (
      frame.readUInt16BE(14) === 1 &&
      frame.readUInt16BE(16) === 0x0800 &&
      frame[18] === 6 &&
      frame[19] === 4 &&
      [1, 2].includes(frame.readUInt16BE(20))
    );
  }
  if (type !== 0x0800 || frame[14] !== 0x45) return false;
  const length = frame.readUInt16BE(16);
  if (
    length < 28 ||
    length + 14 > frame.length ||
    frame.readUInt16BE(20) & 0x3fff
  )
    return false;
  const protocol = frame[23];
  const source = frame.readUInt32BE(26);
  const destination = frame.readUInt32BE(30);
  // DHCP is the only permitted traffic to the virtual subnet or broadcast.
  if (
    protocol === 17 &&
    frame.readUInt16BE(34) === 68 &&
    frame.readUInt16BE(36) === 67 &&
    (source === 0 || source === 0x0a00020f) &&
    (destination === 0xffffffff || destination === 0x0a000202)
  )
    return true;
  if (source !== 0x0a00020f || !publicIpv4(frame.subarray(30, 34)))
    return false;
  if (protocol === 17)
    return frame.readUInt16BE(38) >= 8 && frame.readUInt16BE(38) <= length - 20;
  return (
    protocol === 6 &&
    length >= 40 &&
    frame[46] >> 4 >= 5 &&
    (frame[46] >> 4) * 4 <= length - 20
  );
}

export class WfcGateway {
  constructor({
    helper,
    allowedOrigins,
    log,
    spawnHelper = spawn,
    now = Date.now,
  }) {
    this.helper = helper;
    this.allowedOrigins = allowedOrigins;
    this.log = log;
    this.spawnHelper = spawnHelper;
    this.now = now;
    this.sessions = new Map();
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: WFC_MAX_FRAME,
      perMessageDeflate: false,
    });
    this.timer = setInterval(() => this.sweep(), 10_000).unref();
  }

  async create(owner) {
    if (!this.helper || !this.allowedOrigins.length)
      return { status: 503, error: "WFC gateway is not configured" };
    try {
      await access(this.helper, constants.X_OK);
    } catch {
      return { status: 503, error: "WFC gateway executable is unavailable" };
    }
    this.sweep(false);
    if (typeof owner !== "string" || !/^[0-9]{1,20}$/.test(owner))
      return { status: 400, error: "Invalid WFC owner" };
    if ([...this.sessions.values()].some((s) => s.owner === owner))
      return {
        status: 409,
        error: "A WFC session is already open for this account",
      };
    if (this.sessions.size >= MAX_SESSIONS)
      return { status: 429, error: "WFC capacity reached" };
    const token = randomBytes(32).toString("base64url");
    const session = {
      owner,
      token,
      expires: this.now() + TICKET_MS,
      ws: null,
      child: null,
    };
    this.sessions.set(token, session);
    return {
      status: 201,
      path: `/v1/rooms/wfc/connect?token=${token}`,
      expiresIn: TICKET_MS / 1000,
    };
  }

  upgrade(request, socket, head) {
    const url = new URL(request.url, "http://bridge");
    if (url.pathname !== "/v1/rooms/wfc/connect") return false;
    const session = this.sessions.get(url.searchParams.get("token"));
    if (
      !session ||
      session.ws ||
      session.expires <= this.now() ||
      !this.allowedOrigins.includes(request.headers.origin)
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return true;
    }
    // Consume the ticket before the upgrade callback to reject concurrent reuse.
    session.ws = true;
    socket.once("close", () => {
      if (session.ws === true) this.closeSession(session, "WFC upgrade closed");
    });
    try {
      this.wss.handleUpgrade(request, socket, head, (ws) =>
        this.attach(session, ws),
      );
    } catch {
      this.closeSession(session, "WFC upgrade failed");
      socket.destroy();
    }
    return true;
  }

  attach(session, ws) {
    session.ws = ws;
    session.alive = true;
    let child;
    try {
      child = this.spawnHelper(this.helper, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: process.env.PATH },
      });
    } catch {
      this.closeSession(session, "WFC gateway failed to start");
      return;
    }
    session.child = child;
    let buffered = Buffer.alloc(0),
      windowStart = this.now(),
      bytes = 0;
    let received = 0,
      sent = 0,
      dropped = 0;
    const stop = (reason) => this.closeSession(session, reason);
    ws.on("pong", () => {
      session.alive = true;
    });
    ws.on("error", () => stop("WFC connection failed"));
    ws.on("close", () => stop("WFC connection closed"));
    child.on("error", () => stop("WFC gateway failed"));
    child.on("exit", () => stop("WFC gateway exited"));
    child.stdin.on("error", () => stop("WFC gateway input closed"));
    child.stderr.resume();
    ws.on("message", (frame, binary) => {
      if (this.now() - windowStart >= 1000) {
        windowStart = this.now();
        bytes = 0;
      }
      bytes += frame.length;
      if (bytes > QUEUE_LIMIT || child.stdin.writableLength > QUEUE_LIMIT)
        return stop("WFC traffic limit exceeded");
      if (!binary || !allowedWfcFrame(frame)) {
        dropped++;
        return;
      }
      const packet = Buffer.allocUnsafe(frame.length + 2);
      packet.writeUInt16BE(frame.length);
      frame.copy(packet, 2);
      child.stdin.write(packet);
      sent++;
    });
    child.stdout.on("data", (chunk) => {
      if (buffered.length + chunk.length > QUEUE_LIMIT)
        return stop("WFC output limit exceeded");
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        const length = buffered.readUInt16BE(0);
        if (length < 14 || length > WFC_MAX_FRAME)
          return stop("Invalid WFC gateway frame");
        if (buffered.length < length + 2) break;
        if (ws.bufferedAmount > QUEUE_LIMIT)
          return stop("WFC browser is not receiving");
        if (ws.readyState === WebSocket.OPEN)
          ws.send(buffered.subarray(2, length + 2), { binary: true });
        buffered = buffered.subarray(length + 2);
        received++;
      }
    });
    session.summary = () => ({ sent, received, dropped });
    this.log("wfc_connected", { owner: session.owner });
  }

  closeSession(session, reason) {
    if (!this.sessions.delete(session.token)) return;
    session.child?.kill("SIGKILL");
    if (session.ws && typeof session.ws !== "boolean") {
      session.ws.terminate();
    }
    this.log("wfc_closed", {
      owner: session.owner,
      reason,
      ...session.summary?.(),
    });
  }

  sweep(heartbeat = true) {
    for (const session of this.sessions.values()) {
      if (!session.ws || session.ws === true) {
        if (session.expires <= this.now())
          this.closeSession(session, "WFC ticket expired");
      } else if (heartbeat && session.ws !== true) {
        if (!session.alive) this.closeSession(session, "WFC heartbeat expired");
        else {
          session.alive = false;
          session.ws.ping();
        }
      }
    }
  }

  close() {
    clearInterval(this.timer);
    for (const session of this.sessions.values())
      this.closeSession(session, "WFC gateway stopped");
    this.wss.close();
  }
}
