import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";

const hash = (value) => createHash("sha256").update(value).digest("hex");

export class SaveOutbox {
  constructor(directory) {
    this.directory = directory;
    this.entries = new Map();
    this.pending = Promise.resolve();
  }

  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const entry = JSON.parse(
        await readFile(join(this.directory, name), "utf8"),
      );
      if (entry.id !== name.slice(0, -5) || typeof entry.revision !== "string")
        throw new Error("Invalid saved netplay outbox entry");
      this.entries.set(entry.id, entry);
    }
    return this;
  }

  serial(action) {
    const result = this.pending.then(action);
    this.pending = result.catch(() => {});
    return result;
  }

  put(value) {
    return this.serial(async () => {
      const id = hash(
        JSON.stringify([value.roomId, value.owner, value.player, value.romId]),
      );
      const previous = this.entries.get(id);
      if (
        previous &&
        (previous.generation > value.generation ||
          (previous.generation === value.generation &&
            previous.frame > value.frame))
      )
        return;
      if (!previous && this.entries.size >= 256)
        throw new Error("The server save queue is full");
      const entry = {
        ...value,
        id,
        revision: randomBytes(16).toString("hex"),
        error: null,
      };
      await this.write(entry);
      this.entries.set(id, entry);
    });
  }

  async write(entry) {
    const path = join(this.directory, entry.id + ".json"),
      temp = path + ".tmp";
    const file = await open(temp, "w", 0o600);
    try {
      await file.writeFile(JSON.stringify(entry));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
    const directory = await open(this.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  list(roomId) {
    return [...this.entries.values()]
      .filter((entry) => !roomId || entry.roomId === roomId)
      .slice(0, 8);
  }

  acknowledge(id, revision, error = null) {
    return this.serial(async () => {
      const entry = this.entries.get(id);
      if (!entry || entry.revision !== revision) return false;
      if (error) {
        const updated = { ...entry, error: String(error).slice(0, 240) };
        await this.write(updated);
        this.entries.delete(id);
        this.entries.set(id, updated);
      } else {
        await unlink(join(this.directory, id + ".json"));
        this.entries.delete(id);
      }
      return true;
    });
  }
}
