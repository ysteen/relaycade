import { ResourceMonitor } from "./resources.mjs";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

const ADMIN_ASSETS = {
  "index.html": "text/html; charset=utf-8",
  "admin.js": "text/javascript; charset=utf-8",
  "admin.css": "text/css; charset=utf-8",
};

export async function adminAsset(name) {
  if (!Object.hasOwn(ADMIN_ASSETS, name)) return null;
  return {
    contentType: ADMIN_ASSETS[name],
    body: await readFile(new URL(`./admin-ui/${name}`, import.meta.url)),
  };
}

export class BridgeAdmin {
  constructor(directory, capacity) {
    this.directory = directory;
    this.capacity = capacity;
    this.settings = {
      roomsEnabled: true,
      maxRooms: capacity,
      saveIntervalSeconds: 15,
    };
    this.events = [];
    this.sequence = 0;
    this.startedAt = Date.now();
    this.resources = new ResourceMonitor();
    this.pending = Promise.resolve();
  }

  validate(value) {
    if (
      !value ||
      Object.keys(value).sort().join() !==
        "maxRooms,roomsEnabled,saveIntervalSeconds" ||
      typeof value.roomsEnabled !== "boolean" ||
      !Number.isInteger(value.maxRooms) ||
      value.maxRooms < 1 ||
      value.maxRooms > this.capacity ||
      !Number.isInteger(value.saveIntervalSeconds) ||
      value.saveIntervalSeconds < 5 ||
      value.saveIntervalSeconds > 120
    )
      throw new Error("Invalid bridge settings");
    return {
      roomsEnabled: value.roomsEnabled,
      maxRooms: value.maxRooms,
      saveIntervalSeconds: value.saveIntervalSeconds,
    };
  }

  async init() {
    if (!this.directory) return this;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      this.settings = this.validate(
        JSON.parse(
          await readFile(join(this.directory, "settings.json"), "utf8"),
        ),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this;
  }

  update(value) {
    const settings = this.validate(value);
    if (!this.directory)
      throw new Error("Persistent bridge storage is not configured");
    const action = this.pending.then(async () => {
      const path = join(this.directory, "settings.json");
      const file = await open(path + ".tmp", "w", 0o600);
      try {
        await file.writeFile(JSON.stringify(settings));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(path + ".tmp", path);
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      this.settings = settings;
      return settings;
    });
    this.pending = action.catch(() => {});
    return action;
  }

  record(entry) {
    const fields = {};
    for (const [key, value] of Object.entries(entry)) {
      if (
        ["time", "event", "id"].includes(key) ||
        /password|token|secret|credential|cookie|authorization|battery|^state$/i.test(
          key,
        )
      )
        continue;
      if (typeof value === "string") fields[key] = value.slice(0, 512);
      else if (
        typeof value === "number" ||
        typeof value === "boolean" ||
        value === null
      )
        fields[key] = value;
    }
    this.events.push({
      id: ++this.sequence,
      time: entry.time,
      event: entry.event,
      fields,
    });
    if (this.events.length > 500) this.events.shift();
  }

  logs(after = 0) {
    return {
      events: this.events.filter((entry) => entry.id > after),
      cursor: this.sequence,
      startedAt: this.startedAt,
    };
  }

  status(bridge, transport) {
    const queue = [...(bridge.saves?.entries.values() ?? [])].map((entry) => ({
      roomId: entry.roomId,
      owner: entry.owner,
      player: entry.player,
      romId: entry.romId,
      generation: entry.generation,
      frame: entry.frame,
      error: entry.error,
    }));
    return {
      resources: this.resources.sample(),
      settings: this.settings,
      capacity: this.capacity,
      persistent: !!this.directory,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      transport,
      rooms: [...bridge.rooms.values()].map((room) => ({
        id: room.id,
        system: room.manifest.system,
        players: room.manifest.players,
        current: room.members().length,
        running: !!room.running,
        port: room.tcpPort,
        saves: room.saveStatus(),
      })),
      saves: {
        enabled: !!bridge.saves,
        pending: queue.length,
        failed: queue.filter((item) => item.error).length,
        queue,
      },
    };
  }
}
