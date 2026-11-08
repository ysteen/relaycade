// Layouts are pinned to the core versions shipped in the RomM adapter.
export function supportsSaves(manifest) {
  return (
    (manifest.coreName === "mGBA Splitscreen" &&
      ["0.1.0-f1d5975-rollback2", "0.1.0-f1d5975-cable1"].includes(
        manifest.coreVersion,
      )) ||
    (manifest.coreName === "SameBoy" &&
      ["1.0.4c87d256-rollback2", "1.0.4c87d256-cable1"].includes(
        manifest.coreVersion,
      )) ||
    (manifest.coreName === "Snes9x" &&
      manifest.coreVersion === "1.632d4cce69" &&
      Number.isInteger(manifest.saveSize))
  );
}

function check(condition) {
  if (!condition)
    throw new Error("Unsupported or malformed cartridge save snapshot");
}

function slice(bytes, offset, size, end = bytes.length) {
  check(
    Number.isSafeInteger(offset) &&
      Number.isInteger(size) &&
      offset >= 0 &&
      size >= 0 &&
      size <= 131072 &&
      offset + size <= end,
  );
  return Buffer.from(bytes.subarray(offset, offset + size));
}

function mgba(bytes, players, cable) {
  check(
    bytes.length >= 12 + players * 4 &&
      bytes.toString("ascii", 0, 4) === "SPST" &&
      bytes.readUInt32LE(4) === (cable ? 5 : 4) &&
      bytes.readUInt32LE(8) === players,
  );
  let offset = 12 + players * 4;
  const saves = [];
  for (let player = 0; player < players; player++) {
    const length = bytes.readUInt32LE(12 + player * 4),
      end = offset + length;
    check(length >= 0x61000 && end <= bytes.length);
    if (length === 0x61000) {
      saves.push(Buffer.alloc(0));
      offset = end;
      continue;
    }
    const entries = [];
    let cursor = offset + 0x61000;
    for (let count = 0; ; count++) {
      check(count < 64 && cursor + 16 <= end);
      const tag = bytes.readUInt32LE(cursor),
        size = bytes.readUInt32LE(cursor + 4);
      const start = Number(bytes.readBigUInt64LE(cursor + 8));
      cursor += 16;
      if (!tag) break;
      check(
        Number.isSafeInteger(start) &&
          start >= 0x61000 &&
          start + size <= length,
      );
      entries.push({ tag, size, start: offset + start });
    }
    check(entries.every((entry) => entry.start >= cursor));
    const saved = entries.filter((entry) => entry.tag === 2);
    check(saved.length <= 1);
    saves.push(
      saved.length
        ? slice(bytes, saved[0].start, saved[0].size, end)
        : Buffer.alloc(0),
    );
    offset = end;
  }
  return saves;
}

function sameboy(bytes, players, cable) {
  const end = bytes.length - (cable ? 64 : 48);
  check(
    end > 0 &&
      bytes.toString("ascii", end, end + 4) === (cable ? "SBR3" : "SBR2") &&
      bytes.readUInt32LE(end + 4) === players,
  );
  const saves = [];
  let start = 0;
  for (let player = 0; player < players; player++) {
    let found = false,
      candidate = start + 4;
    for (let tries = 0; tries < 1024 && !found; tries++) {
      candidate = bytes.indexOf("BESS", candidate);
      check(candidate >= start + 4 && candidate + 4 <= end);
      const footer = candidate - 4;
      let cursor = start + bytes.readUInt32LE(footer),
        saved;
      try {
        check(cursor > start && cursor < footer);
        const blocksStart = cursor;
        for (let count = 0; ; count++) {
          check(count < 64 && cursor + 8 <= footer);
          const tag = bytes.toString("ascii", cursor, cursor + 4),
            size = bytes.readUInt32LE(cursor + 4);
          cursor += 8;
          check(cursor + size <= footer);
          if (tag === "CORE") {
            check(
              saved === undefined &&
                size === 208 &&
                bytes.readUInt16LE(cursor) === 1,
            );
            saved = slice(
              bytes,
              start + bytes.readUInt32LE(cursor + 172),
              bytes.readUInt32LE(cursor + 168),
              blocksStart,
            );
          }
          if (tag === "END ") {
            check(
              size === 0 &&
                saved !== undefined &&
                footer - cursor <= 128 &&
                bytes.subarray(cursor, footer).every((value) => value === 0),
            );
            break;
          }
          cursor += size;
        }
        saves.push(saved);
        start = candidate + 4;
        found = true;
      } catch {
        candidate += 4;
      }
    }
    check(found);
  }
  check(bytes.subarray(start, end).every((value) => value === 0));
  return saves;
}

function snes(bytes, size) {
  check(bytes.toString("ascii", 0, 14) === "#!s9xsnp:0012\n");
  let cursor = 14,
    saved;
  for (let count = 0; cursor < bytes.length; count++) {
    check(
      count < 128 &&
        cursor + 11 <= bytes.length &&
        bytes[cursor + 3] === 58 &&
        bytes[cursor + 10] === 58,
    );
    const tag = bytes.toString("ascii", cursor, cursor + 3),
      field = bytes.toString("ascii", cursor + 4, cursor + 10);
    const length = /^\d{6}$/.test(field)
      ? Number(field)
      : bytes[cursor + 4] === 45 && bytes[cursor + 5] === 45
        ? bytes.readUInt32BE(cursor + 6)
        : -1;
    cursor += 11;
    check(length >= 0 && cursor + length <= bytes.length);
    if (tag === "SRA") {
      check(saved === undefined && length === 0x80000 && size <= length);
      saved = slice(bytes, cursor, size, cursor + length);
    }
    cursor += length;
  }
  check(saved !== undefined);
  return [saved];
}

export function extractSaves(manifest, state) {
  check(supportsSaves(manifest));
  const bytes = Buffer.from(state.buffer, state.byteOffset, state.byteLength);
  const cable = manifest.coreVersion.endsWith("-cable1");
  if (manifest.system === "gba") return mgba(bytes, manifest.players, cable);
  if (manifest.system === "gb") return sameboy(bytes, manifest.players, cable);
  return snes(bytes, manifest.saveSize);
}
