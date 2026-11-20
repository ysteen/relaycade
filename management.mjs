import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { adminAsset } from "./admin.mjs";

const COOKIE = "__Secure-netplay_admin";
const SESSION_SECONDS = 8 * 60 * 60;
const SESSION_LIMIT = 32;
const MAX_LOGIN_BODY = 4096;
const SETTINGS_FILE = "romm-integration.json";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("base64url");

function matches(value, expected) {
  return (
    typeof value === "string" &&
    !!expected &&
    timingSafeEqual(
      Buffer.from(digest(value), "hex"),
      Buffer.from(expected, "hex"),
    )
  );
}

function origin(value, httpsOnly = false) {
  if (typeof value !== "string" || value.length > 2048)
    throw new Error("Invalid site URL");
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    (httpsOnly && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Expected a site origin without a path");
  return url.origin;
}

function serviceDigest(token) {
  if (
    typeof token !== "string" ||
    token.length < 24 ||
    token.length > 256 ||
    !/^[!-~]+$/.test(token)
  )
    throw new Error(
      "Bridge service token must contain 24 to 256 printable characters without spaces",
    );
  return digest(token);
}

export class BridgeManagement {
  constructor(
    admin,
    { adminToken, password, publicOrigin, username = "admin" },
  ) {
    this.admin = admin;
    this.serviceTokenHash = adminToken ? serviceDigest(adminToken) : "";
    if (!password && !adminToken)
      throw new Error(
        "Configure a bridge service token or a standalone administrator",
      );
    if (password) {
      if (
        typeof password !== "string" ||
        password.length < 16 ||
        password.length > 256
      )
        throw new Error(
          "Standalone administrator password must contain 16 to 256 characters",
        );
      if (!/^[\w.@-]{1,64}$/.test(username))
        throw new Error("Invalid standalone administrator username");
      this.origin = origin(publicOrigin, true);
      this.username = username;
      this.passwordHash = digest(password);
      if (this.passwordHash === this.serviceTokenHash)
        throw new Error(
          "Use different passwords for the administrator and the RomM service",
        );
    }
    this.tokenOverride = "";
    this.site = "";
    this.lastRequestAt = null;
    this.sessions = new Map();
    this.loginFailures = [];
  }

  async init() {
    if (!this.admin.directory) return this;
    let saved;
    try {
      saved = JSON.parse(
        await readFile(join(this.admin.directory, SETTINGS_FILE), "utf8"),
      );
    } catch (error) {
      if (error.code === "ENOENT") return this;
      throw error;
    }
    this.site = saved.site ? origin(saved.site) : "";
    if (saved.tokenHash) {
      if (
        !/^[a-f0-9]{64}$/.test(saved.tokenHash) ||
        saved.tokenHash === this.passwordHash
      )
        throw new Error("Invalid stored RomM token");
      this.tokenOverride = this.serviceTokenHash = saved.tokenHash;
    }
    return this;
  }

  authorizeService(header) {
    if (
      !header?.startsWith("Bearer ") ||
      !matches(header.slice(7), this.serviceTokenHash)
    )
      return false;
    this.lastRequestAt = new Date().toISOString();
    return true;
  }

  integration() {
    return {
      site: this.site,
      tokenConfigured: !!this.serviceTokenHash,
      lastRequestAt: this.lastRequestAt,
    };
  }

  async updateIntegration(value) {
    if (
      !value ||
      typeof value.site !== "string" ||
      typeof value.token !== "string"
    )
      throw new Error("Invalid RomM connection settings");
    const site = value.site.trim() ? origin(value.site.trim()) : "";
    const nextHash = value.token ? serviceDigest(value.token) : "";
    if (nextHash && nextHash === this.passwordHash)
      throw new Error(
        "The RomM token must differ from the administrator password",
      );
    const update = () => {
      const tokenHash = nextHash || this.tokenOverride;
      if (site && !(tokenHash || this.serviceTokenHash))
        throw new Error("Configure a shared token for RomM");
      return { site, tokenHash };
    };
    await this.admin.persist(SETTINGS_FILE, update, ({ site, tokenHash }) => {
      if (
        site !== this.site ||
        (tokenHash && tokenHash !== this.serviceTokenHash)
      )
        this.lastRequestAt = null;
      this.site = site;
      this.tokenOverride = tokenHash;
      if (tokenHash) this.serviceTokenHash = tokenHash;
    });
    return this.integration();
  }

  session(request) {
    const cookie = request.headers.cookie?.match(
      /(?:^|;\s*)__Secure-netplay_admin=([A-Za-z0-9_-]{43})(?:;|$)/,
    )?.[1];
    const session = this.sessions.get(cookie);
    if (!session) return null;
    if (Date.now() < session.expires) return { ...session, cookie };
    this.sessions.delete(cookie);
    return null;
  }

  setCookie(response, value, maxAge) {
    response.setHeader(
      "Set-Cookie",
      `${COOKIE}=${value}; Path=/admin; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`,
    );
  }

  async handle(
    request,
    response,
    url,
    { reply, body, overview, updateSettings },
  ) {
    const { pathname: path } = url;
    const { method } = request;
    if (!this.origin)
      return reply(404, { detail: "Standalone administration is disabled" });
    if ((path === "/admin" || path === "/admin/") && method === "GET") {
      response.writeHead(302, {
        Location: "/admin/api/ui/",
        "Cache-Control": "no-store",
      });
      return response.end();
    }
    if (path.startsWith("/admin/api/ui/") && method === "GET") {
      const name = path.slice("/admin/api/ui/".length) || "index.html";
      const asset = await adminAsset(name);
      if (!asset) return reply(404, { detail: "Admin asset not found" });
      response.writeHead(200, {
        "Content-Type": asset.contentType,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      });
      return response.end(asset.body);
    }
    if (method !== "GET" && request.headers.origin !== this.origin)
      return reply(403, { detail: "Invalid administrator request origin" });
    if (path === "/admin/api/login" && method === "POST") {
      const value = await body(request, MAX_LOGIN_BODY);
      const now = Date.now();
      this.loginFailures = this.loginFailures.filter(
        (time) => now - time < 60_000,
      );
      if (this.loginFailures.length >= 10)
        return reply(429, {
          detail: "Too many login attempts. Try again in a minute.",
        });
      if (
        value?.username !== this.username ||
        !matches(value?.password, this.passwordHash)
      ) {
        this.loginFailures.push(now);
        return reply(401, {
          detail: "Invalid administrator username or password",
        });
      }
      const previous = this.session(request);
      if (previous) this.sessions.delete(previous.cookie);
      for (const [key, session] of this.sessions)
        if (session.expires <= now) this.sessions.delete(key);
      if (this.sessions.size >= SESSION_LIMIT)
        this.sessions.delete(this.sessions.keys().next().value);
      const key = random();
      this.sessions.set(key, {
        csrf: random(),
        expires: now + SESSION_SECONDS * 1000,
      });
      this.loginFailures = [];
      this.setCookie(response, key, SESSION_SECONDS);
      return reply(200, { authenticated: true });
    }
    const session = this.session(request);
    if (!session)
      return reply(401, { detail: "Administrator sign-in required" });
    if (
      method !== "GET" &&
      !matches(request.headers["x-netplay-csrf"], digest(session.csrf))
    )
      return reply(403, { detail: "Invalid administrator request token" });
    if (path === "/admin/api/logout" && method === "POST") {
      this.sessions.delete(session.cookie);
      this.setCookie(response, "", 0);
      return reply(200, { authenticated: false });
    }
    if (path === "/admin/api/context" && method === "GET")
      return reply(200, {
        application_name: "RomM",
        application_url: this.site,
        csrf_header: "x-netplay-csrf",
        csrf_token: session.csrf,
      });
    if (path === "/admin/api" && method === "GET")
      return reply(200, {
        username: this.username,
        integration: this.integration(),
        broker: overview(),
      });
    if (path === "/admin/api/integration" && method === "PUT")
      return reply(
        200,
        await this.updateIntegration(await body(request, MAX_LOGIN_BODY)),
      );
    if (path === "/admin/api/settings" && method === "PUT")
      return reply(
        200,
        await updateSettings(await body(request, MAX_LOGIN_BODY)),
      );
    if (path === "/admin/api/logs" && method === "GET") {
      const after = Number(url.searchParams.get("after") ?? 0);
      if (!Number.isSafeInteger(after) || after < 0)
        return reply(400, { detail: "Invalid log cursor" });
      return reply(200, this.admin.logs(after));
    }
    return reply(404, { detail: "Administrator route not found" });
  }
}
