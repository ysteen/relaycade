import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const destination = process.argv.slice(2).find((value) => value !== "--check");
assert.ok(
  destination,
  "Usage: node scripts/sync-romm-client.mjs <RomM checkout> [--check]",
);
const hashes = {};
for (const name of [
  "bridge-session.js",
  "bridge-calibration.js",
  "link-core.js",
]) {
  const source = await readFile(resolve(root, "client", name));
  hashes[name] = createHash("sha256").update(source).digest("hex");
  const target = resolve(destination, "custom-emulatorjs/data/src", name);
  if (check)
    assert.deepEqual(await readFile(target), source, `Client drift: ${name}`);
  else await writeFile(target, source);
}
const metadata = {
  project: "retroarch-netplay-bridge",
  protocol: 1,
  sha256: hashes,
};
const manifest = resolve(
  destination,
  "custom-emulatorjs/data/src/bridge-vendor.json",
);
if (check)
  assert.deepEqual(JSON.parse(await readFile(manifest, "utf8")), metadata);
else await writeFile(manifest, JSON.stringify(metadata, null, 2) + "\n");
console.log(
  check
    ? "RomM client matches the standalone project"
    : "Updated RomM client modules",
);
