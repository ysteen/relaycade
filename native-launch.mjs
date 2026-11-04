import { createHash, timingSafeEqual } from "node:crypto";

export const NATIVE_PREPARE_MS = 15 * 60_000;

export function cartridgeManifest(body) {
  if (body.cartridges === undefined) return null;
  const count = body.system === "snes" ? 1 : body.players;
  if (!Array.isArray(body.cartridges) || body.cartridges.length !== count)
    throw new Error("Expected one cartridge for each console");
  return body.cartridges.map(cartridgeDescription);
}

export function cartridgeDescription(rom) {
  if (
    !rom ||
    !Number.isSafeInteger(rom.romId) ||
    rom.romId < 1 ||
    !/^[a-f0-9]{64}$/.test(rom.sha256) ||
    !Number.isInteger(rom.size) ||
    rom.size < 1 ||
    rom.size > 32 * 1024 * 1024 ||
    !Number.isInteger(rom.crc32) ||
    rom.crc32 < 0 ||
    rom.crc32 > 0xffffffff
  )
    throw new Error("Invalid cartridge manifest");
  return {
    romId: rom.romId,
    sha256: rom.sha256,
    size: rom.size,
    crc32: rom.crc32,
  };
}

export function passwordMatches(salt, password, response) {
  const prefix = salt.toString(16).toUpperCase().padStart(8, "0");
  const expected = Buffer.from(
    createHash("sha256")
      .update(prefix + password)
      .digest("hex")
      .toUpperCase(),
  );
  const supplied = Buffer.from(response.toString("ascii").toUpperCase());
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

export function decodeBattery(value = "") {
  if (
    typeof value !== "string" ||
    value.length > 174764 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new Error("Invalid cartridge save");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > 131072) throw new Error("Cartridge save is too large");
  return bytes;
}
