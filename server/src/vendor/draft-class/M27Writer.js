/**
 * M27 Draft Class Writer
 *
 * Writes prospects into a copy of an M27 CAREERDRAFT-* template (455 blocks,
 * 5876 bytes each). Block position = draft order (block 0 = pick 1), same as M26.
 * Blocks past the prospect list are fully zeroed, matching the game's own files.
 *
 * Key M27 differences from M26 (see M27Parser.js for the field map):
 * - visual JSON stored UNCOMPRESSED in a 5632-byte region; we rebuild it wholesale
 * - 244-byte attribute section with +4-shifted fields and a restructured tail
 * - persona DNA: 5 x U16 trait slots at 0xca (prospect.personaDNA: number[])
 * - real face asset (PEPS) goes to the 42-byte binary assetName field at 0xa0
 */

const { M27_BLOCK_SIZE, M27_VISUAL_SIZE, M27_ATTRIBUTE_OFFSET, M27_ATTRIBUTE_SIZE, M27_FIELDS, M27_RATINGS } = require('./M27Parser');

/**
 * @param {Buffer} originalBuffer - M27 template file buffer
 * @param {Array} prospects - prospects in draft order
 * @param {{ dataStartOffset: number }} header
 * @returns {Buffer}
 */
function writeM27DraftClass(originalBuffer, prospects, header) {
  const buf = Buffer.from(originalBuffer);
  const dataStart = header.dataStartOffset;
  const capacity = Math.floor((buf.length - dataStart) / M27_BLOCK_SIZE);
  const n = Math.min(prospects.length, capacity);

  for (let i = 0; i < n; i++) {
    const blockStart = dataStart + i * M27_BLOCK_SIZE;
    writeM27AttributeData(buf, blockStart + M27_ATTRIBUTE_OFFSET, prospects[i], i);
    writeM27VisualJSON(buf, blockStart, prospects[i]);
  }

  // Zero every unused block (the game's own files keep them fully zeroed).
  for (let i = n; i < capacity; i++) {
    const blockStart = dataStart + i * M27_BLOCK_SIZE;
    buf.fill(0, blockStart, blockStart + M27_BLOCK_SIZE);
  }
  // Header prospect count (U16 @0x42). The template carries the game's own 389;
  // the game honours this field, so it must match what we actually wrote.
  buf.writeUInt16LE(n & 0xffff, HEADER_COUNT_OFFSET);
  return buf;
}

const HEADER_COUNT_OFFSET = 0x42;

function writeAscii(buf, off, str, len) {
  buf.write(String(str ?? '').slice(0, len).padEnd(len, '\0'), off, len, 'ascii');
}

/** Write one prospect's 244-byte attribute section (fresh, not template-merged —
 *  every field we don't write stays zero, matching the game's random classes). */
function writeM27AttributeData(buffer, offset, prospect, blockIndex = 0) {
  buffer.fill(0, offset, offset + M27_ATTRIBUTE_SIZE);

  writeAscii(buffer, offset + M27_FIELDS.firstName.off, prospect.firstName, M27_FIELDS.firstName.len);
  writeAscii(buffer, offset + M27_FIELDS.lastName.off, prospect.lastName, M27_FIELDS.lastName.len);
  if (prospect.homeState !== undefined) buffer[offset + M27_FIELDS.homeState.off] = prospect.homeState & 0xff;
  if (prospect.homeTown != null) writeAscii(buffer, offset + M27_FIELDS.homeTown.off, prospect.homeTown, M27_FIELDS.homeTown.len);
  buffer.writeUInt16LE((prospect.college || 0) & 0xffff, offset + M27_FIELDS.college.off);
  if (prospect.age !== undefined) buffer[offset + M27_FIELDS.age.off] = prospect.age & 0xff;
  if (prospect.heightInches !== undefined) buffer[offset + M27_FIELDS.heightInches.off] = prospect.heightInches & 0xff;
  if (prospect.weight !== undefined) buffer[offset + M27_FIELDS.weight.off] = Math.max(0, prospect.weight - 160) & 0xff;
  if (prospect.position !== undefined) buffer[offset + M27_FIELDS.position.off] = prospect.position & 0xff;
  if (prospect.archetype !== undefined) buffer[offset + M27_FIELDS.archetype.off] = prospect.archetype & 0xff;
  if (prospect.jerseyNum !== undefined) buffer[offset + M27_FIELDS.jerseyNum.off] = prospect.jerseyNum & 0xff;
  // Draft pick (U16): drafted players carry their within-round pick; undrafted
  // players carry their block index - exactly what the game's own classes do.
  const undrafted = prospect.draftRound == null || prospect.draftRound >= 63;
  const pick = undrafted ? (blockIndex | 0) : Math.max(0, prospect.draftPick | 0);
  buffer.writeUInt16LE(pick & 0xffff, offset + M27_FIELDS.draftPick.off);
  if (prospect.draftRound != null) buffer[offset + M27_FIELDS.draftRound.off] = prospect.draftRound & 0xff;
  if (prospect.overall != null) buffer[offset + M27_FIELDS.overall.off] = Math.max(0, Math.min(99, prospect.overall));
  if (prospect.devTrait !== undefined) buffer[offset + M27_FIELDS.devTrait.off] = prospect.devTrait & 0xff;
  if (prospect.commentaryId !== undefined) buffer.writeUInt16LE(prospect.commentaryId & 0xffff, offset + M27_FIELDS.commentaryId.off);
  if (prospect.PID !== undefined) buffer.writeUInt16LE(prospect.PID & 0xffff, offset + M27_FIELDS.PID.off);

  // Fields the game fills on every prospect and copies verbatim into the franchise.
  buffer[offset + M27_FIELDS.const6b.off] = M27_FIELDS.const6b.value;
  buffer[offset + M27_FIELDS.const7d.off] = M27_FIELDS.const7d.value;
  if (prospect.birthdate != null) buffer.writeUInt16LE(prospect.birthdate & 0xffff, offset + M27_FIELDS.birthdate.off);
  if (prospect.personalityRating != null) buffer[offset + M27_FIELDS.personalityRating.off] = Math.max(0, Math.min(99, prospect.personalityRating | 0));
  if (prospect.bodyTypeId != null) buffer[offset + M27_FIELDS.bodyTypeId.off] = prospect.bodyTypeId & 0x07; // 0-3 + Lean/Freshman = 4
  if (prospect.qbStyle != null) buffer[offset + M27_FIELDS.qbStyle.off] = prospect.qbStyle & 0xff;
  if (prospect.focus != null) buffer[offset + M27_FIELDS.focus.off] = prospect.focus & 0x03;
  if (prospect.hidden87 != null) buffer[offset + M27_FIELDS.hidden87.off] = prospect.hidden87 & 0xff;
  if (prospect.hidden9c != null) buffer[offset + M27_FIELDS.hidden9c.off] = prospect.hidden9c & 0xff;

  // Ratings (M26 order, +4 offsets)
  for (const [key, off] of Object.entries(M27_RATINGS)) {
    if (prospect[key] !== undefined) buffer[offset + off] = Math.max(0, Math.min(99, prospect[key]));
  }

  // Real face asset -> 42-byte binary field at 0xa0; generic faces (gen_*) live in
  // the visual JSON's genericHeadName and this field stays zeroed.
  const peps = prospect.PEPS ?? prospect.assetName ?? null;
  if (typeof peps === 'string' && peps && !/^gen_/i.test(peps)) {
    writeAscii(buffer, offset + M27_FIELDS.assetName.off, peps, M27_FIELDS.assetName.len);
  }

  // Persona DNA: up to 5 trait ids (indexes into the game's 65-value DNA enum).
  if (Array.isArray(prospect.personaDNA)) {
    for (let i = 0; i < 5; i++) {
      const v = prospect.personaDNA[i] | 0;
      buffer.writeUInt16LE(v & 0xffff, offset + M27_FIELDS.personaDNA.off + i * 2);
    }
  }
}

/** Rebuild the visual JSON wholesale (uncompressed, zero-padded to 5632 bytes). */
function writeM27VisualJSON(buffer, blockStart, prospect) {
  const src = prospect.visuals || {};
  const bodyType = prospect.bodyType || src.bodyType || 'Muscular';

  // Face: generic heads go in genericHeadName; real assets are binary-only.
  // In Madden 27, 3D body skin textures (hands, arms, legs) are derived from genericHeadName.
  let genericHeadName = src.genericHeadName || prospect.assignedGenr || null;
  const peps = prospect.PEPS ?? prospect.assetName ?? null;
  if (!genericHeadName && typeof peps === 'string' && /^gen_/i.test(peps)) genericHeadName = peps;

  // Resolve skinTone from src, prospect attributes, or genericHeadName
  let skinTone = src.skinTone ?? prospect.skinTone ?? prospect.race ?? null;
  if (skinTone == null && genericHeadName) {
    const m = String(genericHeadName).match(/^gen_(\d+)/i);
    if (m) skinTone = parseInt(m[1], 10);
  }
  if (skinTone == null || skinTone < 1 || skinTone > 8) skinTone = 7;

  // Ensure visuals always has a valid tone-matching genericHeadName so body skin never defaults to White
  if (!genericHeadName || !/^gen_\d/i.test(genericHeadName)) {
    const m27ToneFallbacks = {
      1: 'gen_1_B_B_005',
      2: 'gen_2_BMH_S_002',
      3: 'gen_3_BMT_S_003',
      4: 'gen_4_BHM_S_01',
      5: 'gen_5_BHM_M_002',
      6: 'gen_6_BHM_BM_004',
      7: 'gen_7_BHM_MG_001',
      8: 'gen_7_BHM_MG_001',
    };
    genericHeadName = m27ToneFallbacks[skinTone] || 'gen_7_BHM_MG_001';
  }

  const visuals = {};
  if (bodyType) visuals.bodyType = bodyType;
  visuals.genericHeadName = genericHeadName;
  visuals.skinTone = skinTone;

  // Loadouts: use the prospect's PlayerOnField loadout when present (era gear /
  // copied real-player gear already merged by the builder); always include the
  // CharacterBodyType element the M27 template carries.
  const loadouts = [];
  const onField = Array.isArray(src.loadouts)
    ? src.loadouts.find((l) => l && l.loadoutType === 'PlayerOnField')
    : null;
  if (onField && Array.isArray(onField.loadoutElements)) {
    loadouts.push({ loadoutType: 'PlayerOnField', loadoutElements: onField.loadoutElements });
  }
  loadouts.push({
    loadoutCategory: 'Base',
    loadoutElements: [{ itemAssetName: `${bodyType}_BodyType`, slotType: 'CharacterBodyType' }],
  });
  visuals.loadouts = loadouts;

  const json = JSON.stringify(visuals);
  if (json.length > M27_VISUAL_SIZE) throw new Error(`visual JSON too large: ${json.length} > ${M27_VISUAL_SIZE}`);
  buffer.fill(0, blockStart, blockStart + M27_VISUAL_SIZE);
  buffer.write(json, blockStart, json.length, 'utf8');
}

module.exports = { writeM27DraftClass, writeM27AttributeData, writeM27VisualJSON };
