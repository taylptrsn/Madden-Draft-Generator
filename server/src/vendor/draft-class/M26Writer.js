/**
 * M26 Draft Class Writer
 *
 * Writes prospect data to M26 draft class binary format
 * M26 block structure: 4296 bytes (0x10C8) per prospect
 * - First 4096 bytes (0x1000): Visual JSON data (appearance)
 * - Last 200 bytes (0xC8): Attribute binary data (player stats)
 */

const fs = require('fs');
const path = require('path');

const BLOCK_SIZE = 4296; // 0x10C8 - CORRECT value (was incorrectly 4322)

// Load generic head lookup for numeric genericHead values
// This is CRITICAL - the game needs both genericHeadName (string) AND genericHead (number)
let genericHeadLookup = null;
function loadGenericHeadLookup() {
  if (genericHeadLookup !== null) return; // Already loaded

  // Try multiple paths to handle dev vs packaged app
  const possiblePaths = [
    path.join(__dirname, '../../../data/lookups/genericHeadLookup.json'),
    path.join(__dirname, '../../data/lookups/genericHeadLookup.json'),
    path.join(process.cwd(), 'data', 'lookups', 'genericHeadLookup.json'),
    path.join(process.cwd(), '.vite', 'build', 'data', 'lookups', 'genericHeadLookup.json')
  ];

  for (const lookupPath of possiblePaths) {
    try {
      if (fs.existsSync(lookupPath)) {
        genericHeadLookup = JSON.parse(fs.readFileSync(lookupPath, 'utf8'));
        console.log(`[M26Writer] Loaded genericHeadLookup from ${lookupPath}`);
        console.log(`[M26Writer] Contains ${Object.keys(genericHeadLookup.PLYR_GENERICHEAD || {}).length} entries`);
        return;
      }
    } catch (e) {
      console.warn(`[M26Writer] Failed to load from ${lookupPath}: ${e.message}`);
    }
  }

  console.error('[M26Writer] Could not find genericHeadLookup.json in any expected location');
  console.error('[M26Writer] Tried paths:', possiblePaths);
}

// Attempt to load at module initialization
try {
  loadGenericHeadLookup();
} catch (e) {
  console.error('[M26Writer] Failed to load genericHeadLookup:', e.message);
}

/**
 * Get the numeric genericHead value for a given genericHeadName
 * @param {string} genericHeadName - The face name (e.g., "gen_7_B_N_019" or "7_B_N_019")
 * @returns {number|null} The numeric ID or null if not found
 */
function getGenericHeadNumber(genericHeadName) {
  // Ensure lookup is loaded (lazy load if not already loaded)
  if (!genericHeadLookup) {
    loadGenericHeadLookup();
  }
  if (!genericHeadLookup || !genericHeadLookup.PLYR_GENERICHEAD) return null;
  if (!genericHeadName) return null;

  // Strip "gen_" prefix if present to get the lookup key
  let lookupKey = genericHeadName;
  if (lookupKey.toLowerCase().startsWith('gen_')) {
    lookupKey = lookupKey.substring(4); // Remove "gen_" prefix
  }

  const numericId = genericHeadLookup.PLYR_GENERICHEAD[lookupKey];
  if (numericId !== undefined) {
    console.log(`[M26Writer] genericHead lookup: "${lookupKey}" -> ${numericId}`);
    return numericId;
  }

  console.warn(`[M26Writer] No genericHead found for "${lookupKey}"`);
  return null;
}
const ATTRIBUTE_DATA_SIZE = 200; // 0xC8 bytes per attribute section (4296 - 4096 = 200)
const ATTRIBUTE_OFFSET = 0x1000; // 4096 bytes into each block (visual section size)

/**
 * Write M26 draft class file
 * @param {Buffer} originalBuffer - Original file buffer (for preserving structure)
 * @param {Array} prospects - Array of prospect objects with modified data
 * @param {Object} header - File header info
 * @returns {Buffer} Modified file buffer
 */
function writeM26DraftClass(originalBuffer, prospects, header) {
  // DEBUG: Write timestamp to file to prove this function was called
  const os = require('os');
  const debugPath = path.join(os.tmpdir(), 'M26Writer_debug.txt');
  const tracePath = path.join(os.tmpdir(), 'M26Writer_trace.txt');
  const debugMsg = `M26Writer called at ${new Date().toISOString()}\nProspects: ${prospects.length}\n`;
  try { if (process.env.M26_DEBUG) fs.writeFileSync(debugPath, debugMsg, { flag: 'a' }); } catch(e) {}

  // TRACE: Log what we received for first 5 prospects
  const traceLines = [];
  traceLines.push(`\n${'='.repeat(80)}`);
  traceLines.push(`M26WRITER TRACE - ${new Date().toISOString()}`);
  traceLines.push(`${'='.repeat(80)}`);
  traceLines.push(`Prospects received: ${prospects.length}`);

  for (let i = 0; i < Math.min(5, prospects.length); i++) {
    const p = prospects[i];
    traceLines.push(`\n--- Prospect ${i + 1}: ${p.firstName} ${p.lastName} ---`);
    traceLines.push(`  PEPS: "${p.PEPS}" (type: ${typeof p.PEPS})`);
    traceLines.push(`  Has visuals: ${!!p.visuals}`);
    if (p.visuals) {
      traceLines.push(`  visuals.genericHeadName: "${p.visuals.genericHeadName}" (type: ${typeof p.visuals?.genericHeadName})`);
      traceLines.push(`  visuals.skinTone: ${p.visuals.skinTone}`);
    } else {
      traceLines.push(`  *** VISUALS IS UNDEFINED IN M26WRITER! ***`);
    }
  }
  try { fs.writeFileSync(tracePath, traceLines.join('\n')); } catch(e) {}
  console.error('[M26Writer] Trace file:', tracePath);

  console.error('[M26Writer] ======== M26WRITER EXECUTING ========');
  console.error('[M26Writer] Debug file:', debugPath);

  // Create a copy of the original buffer to preserve all unchanged data
  const modifiedBuffer = Buffer.from(originalBuffer);

  console.log(`[M26Writer] ====================================`);
  console.log(`[M26Writer] Writing ${prospects.length} prospects`);
  console.log(`[M26Writer] dataStartOffset: 0x${header.dataStartOffset.toString(16)}`);
  console.log(`[M26Writer] Buffer size: ${originalBuffer.length} bytes`);

  // IMPORTANT: The game determines draft order by BLOCK POSITION in the file
  // Block 0 = Pick 1, Block 1 = Pick 2, etc.
  // The draftPick field at 0x4e is for "pick within round" (1-32), NOT overall pick
  //
  // DO NOT SORT - write prospects in the exact order they appear in the grid
  // The frontend sends them in grid display order, which IS the draft order
  const sortedProspects = prospects; // Use array as-is, no sorting

  console.log(`[M26Writer] Writing prospects in grid order (block position = draft order)`);
  console.log(`[M26Writer] First 5 prospects to write:`);
  for (let i = 0; i < Math.min(5, sortedProspects.length); i++) {
    console.log(`  Block ${i} (Pick ${i+1}): ${sortedProspects[i].firstName} ${sortedProspects[i].lastName}`);
  }

  // Debug first 5 prospects with full data
  for (let i = 0; i < Math.min(5, sortedProspects.length); i++) {
    console.log(`[M26Writer] Prospect #${i + 1} received:`);
    console.log(`  firstName: ${sortedProspects[i].firstName}`);
    console.log(`  lastName: ${sortedProspects[i].lastName}`);
    console.log(`  position: ${sortedProspects[i].position}`);
    console.log(`  speed: ${sortedProspects[i].speed}`);
    console.log(`  throwPower: ${sortedProspects[i].throwPower}`);
    console.log(`  awareness: ${sortedProspects[i].awareness}`);
    console.log(`  PEPS: ${sortedProspects[i].PEPS}`);
    console.log(`  bodyType: ${sortedProspects[i].bodyType}`);
    console.log(`  college: ${sortedProspects[i].college}`);
    console.log(`  age: ${sortedProspects[i].age}`);
    console.log(`  heightInches: ${sortedProspects[i].heightInches}`);
    console.log(`  weight: ${sortedProspects[i].weight}`);
  }

  let prospectsWritten = 0;
  let prospectsSkipped = 0;
  let prospectsWithoutPEPS = 0;

  for (let i = 0; i < sortedProspects.length; i++) {
    const prospect = sortedProspects[i];
    const blockStart = header.dataStartOffset + (i * BLOCK_SIZE);
    const attributeOffset = blockStart + ATTRIBUTE_OFFSET;

    // Skip if past end of file
    if (attributeOffset + ATTRIBUTE_DATA_SIZE > modifiedBuffer.length) {
      console.warn(`[M26Writer] Skipping prospect ${i + 1} - would exceed file size`);
      console.warn(`[M26Writer]   attributeOffset: ${attributeOffset}, bufferSize: ${modifiedBuffer.length}`);
      prospectsSkipped++;
      break;
    }

    // Write attribute data for this prospect at blockStart + 0x1000
    writeM26AttributeData(modifiedBuffer, attributeOffset, prospect, i);

    // Update visual JSON if PEPS, bodyType, equipment, or face data were modified
    const hasPEPS = prospect.PEPS !== undefined && prospect.PEPS !== null;
    const hasBodyType = prospect.bodyType !== undefined && prospect.bodyType !== null;
    const hasEquipment = prospect.equipment && Object.keys(prospect.equipment).length > 0;
    const hasVisualsLoadouts = prospect.visuals && prospect.visuals.loadouts && prospect.visuals.loadouts.length > 0;
    // CRITICAL: Also check for face picker data (genericHeadName or assignedGenr)
    const hasGenericFace = !!(prospect.visuals?.genericHeadName || prospect.assignedGenr);

    if (i < 3) {
      console.log(`[M26Writer] Prospect #${i + 1} - hasPEPS: ${hasPEPS}, hasBodyType: ${hasBodyType}, hasEquipment: ${hasEquipment}, hasVisualsLoadouts: ${hasVisualsLoadouts}, hasGenericFace: ${hasGenericFace}`);
    }

    if (hasPEPS || hasBodyType || hasEquipment || hasVisualsLoadouts || hasGenericFace) {
      updateM26VisualJSON(modifiedBuffer, blockStart, prospect);
      prospectsWritten++;
    } else {
      prospectsWithoutPEPS++;
    }
  }

  console.log(`[M26Writer] === WRITE SUMMARY ===`);
  console.log(`[M26Writer] Total prospects received: ${sortedProspects.length}`);
  console.log(`[M26Writer] Prospects with PEPS/bodyType written: ${prospectsWritten}`);
  console.log(`[M26Writer] Prospects without PEPS/bodyType: ${prospectsWithoutPEPS}`);
  console.log(`[M26Writer] Prospects skipped (file size): ${prospectsSkipped}`);

  // VERIFICATION: Read back first 5 prospects to confirm data was written
  console.log(`[M26Writer] VERIFICATION - Reading back first 5 prospects from buffer:`);
  for (let v = 0; v < Math.min(5, sortedProspects.length); v++) {
    const blockVStart = header.dataStartOffset + (v * BLOCK_SIZE);
    const attrVOffset = blockVStart + 0x1000; // Attribute section at block + 0x1000
    const firstNameV = modifiedBuffer.toString('ascii', attrVOffset, attrVOffset + 0x11).replace(/\0/g, '').trim();
    const lastNameV = modifiedBuffer.toString('ascii', attrVOffset + 0x11, attrVOffset + 0x26).replace(/\0/g, '').trim();
    const positionV = modifiedBuffer[attrVOffset + 0x4a];
    const draftPickV = modifiedBuffer[attrVOffset + 0x4e];
    const speedV = modifiedBuffer[attrVOffset + 0x7B];

    console.log(`[M26Writer]   Prospect #${v + 1}: ${firstNameV} ${lastNameV} | pos=${positionV} | draftPick=${draftPickV} | spd=${speedV}`);
    console.log(`[M26Writer]   EXPECTED: ${sortedProspects[v].firstName} ${sortedProspects[v].lastName} | draftPick=${sortedProspects[v].draftPick}`);
  }

  console.log(`[M26Writer] Write complete`);
  return modifiedBuffer;
}

/**
 * Write attribute data for a single prospect
 * @param {Buffer} buffer - File buffer to write to
 * @param {number} offset - Offset where attribute data starts
 * @param {Object} prospect - Prospect data
 * @param {number} prospectIndex - Index of this prospect in the array (0-based)
 */
function writeM26AttributeData(buffer, offset, prospect, prospectIndex) {
  // Debug logging for first 3 prospects - comprehensive attribute dump
  if (prospectIndex < 3) {
    console.log(`\n[M26Writer] === WRITING PROSPECT ${prospectIndex + 1}: ${prospect.firstName} ${prospect.lastName} ===`);
    console.log('[M26Writer] CRITICAL - Overall Rating:');
    console.log(`  overall: ${prospect.overall} <-- THIS IS WHAT GETS WRITTEN TO 0x51`);
    console.log('[M26Writer] All QB-related properties:');
    console.log(`  speed: ${prospect.speed}`);
    console.log(`  acceleration: ${prospect.acceleration}`);
    console.log(`  awareness: ${prospect.awareness}`);
    console.log(`  throwPower: ${prospect.throwPower}`);
    console.log(`  throwAccuracyDeep: ${prospect.throwAccuracyDeep}`);
    console.log(`  throwAccuracyMid: ${prospect.throwAccuracyMid}`);
    console.log(`  throwAccuracyShort: ${prospect.throwAccuracyShort}`);
    console.log(`  throwOnTheRun: ${prospect.throwOnTheRun}`);
    console.log(`  throwUnderPressure: ${prospect.throwUnderPressure}`);
    console.log(`  position: ${prospect.position}`);
    console.log(`  injury: ${prospect.injury}`);
    console.log(`  PEPS: ${prospect.PEPS}`);
    console.log(`  bodyType: ${prospect.bodyType}`);

    // Also log keys to see what properties exist
    const keys = Object.keys(prospect);
    console.log(`[M26Writer] Prospect has ${keys.length} properties`);
    // Log rating-related keys
    const ratingKeys = keys.filter(k =>
      k.includes('throw') || k.includes('speed') || k.includes('acceleration') ||
      k.includes('awareness') || k.includes('PSPD') || k.includes('PTAD') || k.includes('PTHP')
    );
    console.log(`[M26Writer] Rating-related keys: ${ratingKeys.join(', ')}`);
  }

  // String fields (first name and last name)
  if (prospect.firstName) {
    if (typeof prospect.firstName !== 'string') {
      console.error(`[M26Writer] ERROR at prospect index ${prospectIndex}:`);
      console.error(`  firstName is type ${typeof prospect.firstName}, value:`, prospect.firstName);
      console.error(`  Full prospect object:`, prospect);
      throw new Error(`firstName must be a string, got ${typeof prospect.firstName}`);
    }
    const firstName = prospect.firstName.slice(0, 0x11).padEnd(0x11, '\0');
    buffer.write(firstName, offset, 0x11, 'ascii');
  }

  if (prospect.lastName) {
    if (typeof prospect.lastName !== 'string') {
      console.error(`[M26Writer] ERROR at prospect index ${prospectIndex}:`);
      console.error(`  lastName is type ${typeof prospect.lastName}, value:`, prospect.lastName);
      console.error(`  Full prospect object:`, prospect);
      throw new Error(`lastName must be a string, got ${typeof prospect.lastName}`);
    }
    const lastName = prospect.lastName.slice(0, 0x15).padEnd(0x15, '\0');
    buffer.write(lastName, offset + 0x11, 0x15, 'ascii');
  }

  // Basic info fields
  if (prospect.homeState !== undefined) buffer[offset + 0x26] = prospect.homeState;

  // homeTown is a 27-byte (0x1B) string at offset 0x27, right after homeState
  if (prospect.homeTown !== undefined && prospect.homeTown !== null) {
    const homeTown = String(prospect.homeTown).slice(0, 0x1B).padEnd(0x1B, '\0');
    buffer.write(homeTown, offset + 0x27, 0x1B, 'ascii');
  }

  // College is a little-endian UInt16 at 0x42-0x43 (the lookup has 494 ids; the
  // shipped template stores ids up to 315 with a nonzero high byte). Writing only
  // the low byte truncated every id >= 256 to the wrong college.
  if (prospect.college !== undefined) buffer.writeUInt16LE((prospect.college || 0) & 0xffff, offset + 0x42);
  if (prospect.age !== undefined) buffer[offset + 0x46] = prospect.age;
  if (prospect.heightInches !== undefined) buffer[offset + 0x47] = prospect.heightInches;
  if (prospect.weight !== undefined) buffer[offset + 0x48] = Math.max(0, prospect.weight - 160);
  if (prospect.position !== undefined) buffer[offset + 0x4a] = prospect.position;
  if (prospect.archetype !== undefined) buffer[offset + 0x4b] = prospect.archetype;
  if (prospect.jerseyNum !== undefined) buffer[offset + 0x4c] = prospect.jerseyNum;

  // Draft order fields - preserve values from original file
  // M26 structure: 0x4d = draftable flag
  //                0x4e = pick number within round (1-32 for drafted)
  //                0x50 = round number (1-7 for drafted, 63 for UDFA)
  if (prospect.draftable !== undefined) buffer[offset + 0x4d] = prospect.draftable;
  if (prospect.draftPick !== undefined && prospect.draftPick !== null) {
    buffer[offset + 0x4e] = prospect.draftPick;
  }
  if (prospect.draftRound !== undefined && prospect.draftRound !== null) {
    buffer[offset + 0x50] = prospect.draftRound;
  }

  // Also log details for first 10 prospects
  if (prospectIndex < 10) {
    console.log(`[M26Writer] === WRITING PROSPECT ${prospectIndex} ===`);
    console.log(`  Block: ${prospectIndex}, Offset: 0x${offset.toString(16)}`);
    console.log(`  Name: ${prospect.firstName} ${prospect.lastName}`);
    console.log(`  draftPick being written: ${prospect.draftPick}`);
  }

  if (prospect.devTrait !== undefined) buffer[offset + 0x8c] = prospect.devTrait;
  if (prospect.PID !== undefined) buffer.writeUInt16LE(prospect.PID, offset + 0x92);

  // Commentary ID at 0x9C (2 bytes, uint16LE) - MUST write to preserve commentary
  // This was missing before, causing commentaryId to reset to template default (32767)
  if (prospect.commentaryId !== undefined) {
    buffer.writeUInt16LE(prospect.commentaryId, offset + 0x9C);
  }

  // CRITICAL FIX: Binary genericHead at 0x8E MUST be 0 for draft classes
  // The game uses visuals JSON genericHeadName for draft classes, NOT this binary field
  // If this is non-zero, the game uses it as a face index and IGNORES genericHeadName
  const oldValue0x8E = buffer.readUInt16LE(offset + 0x8E);
  buffer.writeUInt16LE(0, offset + 0x8E);
  const newValue0x8E = buffer.readUInt16LE(offset + 0x8E);
  console.error(`[M26Writer] *** FACE FIX APPLIED: Prospect ${prospectIndex} - offset 0x${(offset + 0x8E).toString(16)}, was ${oldValue0x8E}, now ${newValue0x8E} ***`);

  // Verify write worked
  if (newValue0x8E !== 0) {
    console.error(`[M26Writer] *** WARNING: 0x8E FIX FAILED! Value is still ${newValue0x8E} ***`);
  }

  // Write Overall Rating to 0x51
  // The game uses this for display AND calculation verification
  // If prospect.overall is provided, write it; otherwise calculate from ratings
  if (prospect.overall !== undefined && prospect.overall !== null) {
    buffer[offset + 0x51] = Math.max(0, Math.min(99, prospect.overall));
    if (prospectIndex < 3) {
      console.log(`[M26Writer] Writing OVR ${prospect.overall} to offset 0x51`);
    }
  }

  // Write all ratings using the correct M26 byte offsets
  // Core Physical Attributes
  if (prospect.speed !== undefined) buffer[offset + 0x7B] = prospect.speed;
  if (prospect.acceleration !== undefined) buffer[offset + 0x52] = prospect.acceleration;
  if (prospect.agility !== undefined) buffer[offset + 0x53] = prospect.agility;
  if (prospect.strength !== undefined) buffer[offset + 0x7F] = prospect.strength;
  if (prospect.awareness !== undefined) buffer[offset + 0x54] = prospect.awareness;
  if (prospect.jumping !== undefined) buffer[offset + 0x62] = prospect.jumping;
  if (prospect.stamina !== undefined) buffer[offset + 0x7D] = prospect.stamina;
  if (prospect.changeOfDirection !== undefined) buffer[offset + 0x5C] = prospect.changeOfDirection;
  if (prospect.toughness !== undefined) buffer[offset + 0x88] = prospect.toughness;
  if (prospect.injury !== undefined) buffer[offset + 0x60] = prospect.injury; // CORRECT: Game reads injury from 0x60

  // Ball Carrier Attributes
  if (prospect.carrying !== undefined) buffer[offset + 0x59] = prospect.carrying;
  if (prospect.ballCarrierVision !== undefined) buffer[offset + 0x55] = prospect.ballCarrierVision;
  if (prospect.breakTackle !== undefined) buffer[offset + 0x58] = prospect.breakTackle;
  if (prospect.trucking !== undefined) buffer[offset + 0x89] = prospect.trucking;
  if (prospect.stiffArm !== undefined) buffer[offset + 0x7E] = prospect.stiffArm;
  if (prospect.spinMove !== undefined) buffer[offset + 0x7C] = prospect.spinMove;
  if (prospect.jukeMove !== undefined) buffer[offset + 0x61] = prospect.jukeMove;

  // Receiving Attributes
  if (prospect.catching !== undefined) buffer[offset + 0x5A] = prospect.catching;
  if (prospect.catchInTraffic !== undefined) buffer[offset + 0x5B] = prospect.catchInTraffic;
  if (prospect.spectacularCatch !== undefined) buffer[offset + 0x7A] = prospect.spectacularCatch;
  if (prospect.shortRouteRunning !== undefined) buffer[offset + 0x75] = prospect.shortRouteRunning;
  if (prospect.mediumRouteRunning !== undefined) buffer[offset + 0x74] = prospect.mediumRouteRunning;
  if (prospect.deepRouteRunning !== undefined) buffer[offset + 0x73] = prospect.deepRouteRunning;
  if (prospect.release !== undefined) buffer[offset + 0x72] = prospect.release;

  // Throwing Attributes (QB)
  if (prospect.throwPower !== undefined) buffer[offset + 0x86] = prospect.throwPower; // CORRECT: Game reads throwPower from 0x86
  if (prospect.throwAccuracyShort !== undefined) buffer[offset + 0x84] = prospect.throwAccuracyShort;
  if (prospect.throwAccuracyMid !== undefined) buffer[offset + 0x82] = prospect.throwAccuracyMid;  // CONFIRMED: 0x82 is TAM (original file analysis)
  if (prospect.throwAccuracyDeep !== undefined) buffer[offset + 0x81] = prospect.throwAccuracyDeep;
  if (prospect.throwOnTheRun !== undefined) buffer[offset + 0x85] = prospect.throwOnTheRun;
  if (prospect.throwUnderPressure !== undefined) buffer[offset + 0x87] = prospect.throwUnderPressure;
  if (prospect.playAction !== undefined) buffer[offset + 0x6D] = prospect.playAction;
  if (prospect.breakSack !== undefined) buffer[offset + 0x57] = prospect.breakSack;

  // Blocking Attributes
  if (prospect.passBlock !== undefined) buffer[offset + 0x6B] = prospect.passBlock;
  if (prospect.passBlockPower !== undefined) buffer[offset + 0x69] = prospect.passBlockPower;
  if (prospect.passBlockFinesse !== undefined) buffer[offset + 0x6A] = prospect.passBlockFinesse;
  if (prospect.runBlock !== undefined) buffer[offset + 0x78] = prospect.runBlock;
  if (prospect.runBlockPower !== undefined) buffer[offset + 0x77] = prospect.runBlockPower;
  if (prospect.runBlockFinesse !== undefined) buffer[offset + 0x76] = prospect.runBlockFinesse;
  if (prospect.leadBlock !== undefined) buffer[offset + 0x66] = prospect.leadBlock;
  if (prospect.impactBlocking !== undefined) buffer[offset + 0x5F] = prospect.impactBlocking;

  // Defensive Attributes
  if (prospect.tackle !== undefined) buffer[offset + 0x80] = prospect.tackle;
  if (prospect.hitPower !== undefined) buffer[offset + 0x5E] = prospect.hitPower;
  if (prospect.powerMoves !== undefined) buffer[offset + 0x6F] = prospect.powerMoves;
  if (prospect.finesseMoves !== undefined) buffer[offset + 0x5D] = prospect.finesseMoves;
  if (prospect.blockShedding !== undefined) buffer[offset + 0x56] = prospect.blockShedding;
  if (prospect.pursuit !== undefined) buffer[offset + 0x71] = prospect.pursuit;
  if (prospect.playRecognition !== undefined) buffer[offset + 0x6E] = prospect.playRecognition;
  if (prospect.manCoverage !== undefined) buffer[offset + 0x68] = prospect.manCoverage;
  if (prospect.zoneCoverage !== undefined) buffer[offset + 0x8A] = prospect.zoneCoverage;
  if (prospect.pressCoverage !== undefined) buffer[offset + 0x70] = prospect.pressCoverage;

  // Special Teams
  if (prospect.kickPower !== undefined) buffer[offset + 0x64] = prospect.kickPower;
  if (prospect.kickAccuracy !== undefined) buffer[offset + 0x63] = prospect.kickAccuracy;
  if (prospect.kickReturn !== undefined) buffer[offset + 0x65] = prospect.kickReturn;
  if (prospect.longSnap !== undefined) buffer[offset + 0x8B] = prospect.longSnap;

  // Position-specific traits (M26 format)
  // These traits are stored sequentially after the main ratings
  // Mapped from roster fields: TRPN->traitPenalty, TRPB->traitPlayBall, etc.
  // NOTE: 0x9C-0x9D is reserved for commentaryId (2 bytes), so traits skip it
  if (prospect.traitPenalty !== undefined) buffer[offset + 0x99] = prospect.traitPenalty;
  if (prospect.traitPlayBall !== undefined) buffer[offset + 0x9A] = prospect.traitPlayBall;
  if (prospect.traitLbStyle !== undefined) buffer[offset + 0x9B] = prospect.traitLbStyle; // Fixed: was 0x9C, conflicting with commentaryId
  if (prospect.traitTendency !== undefined) buffer[offset + 0xA3] = prospect.traitTendency;
  if (prospect.traitPredictability !== undefined) buffer[offset + 0xA6] = prospect.traitPredictability;

  // Also check for roster-format field names (TRPN, TRPB, etc.)
  if (prospect.TRPN !== undefined) buffer[offset + 0x99] = prospect.TRPN;
  if (prospect.TRPB !== undefined) buffer[offset + 0x9A] = prospect.TRPB;
  if (prospect.TRLS !== undefined) buffer[offset + 0x9B] = prospect.TRLS; // Fixed: was 0x9C, conflicting with commentaryId
  if (prospect.TRTN !== undefined) buffer[offset + 0xA3] = prospect.TRTN;
  if (prospect.TRPR !== undefined) buffer[offset + 0xA6] = prospect.TRPR;

  // CRITICAL: Write 42-byte binary assetName field for REAL player assets
  // This is a SEPARATE binary field at the END of the 200-byte player data section
  // Offset: 200 - 42 = 158 (0x9E)
  // Real assets (like "WilliamsCaleb_14500") go here, NOT in visuals JSON
  // Generic assets (like "gen_7_B_G_005") go to visuals.genericHeadName only

  // CRITICAL: If PEPS is explicitly empty string, we MUST clear the binary field
  // This allows converting a real player face to a generic face
  const pepsIsExplicitlyEmpty = prospect.PEPS === '';
  let newPEPS = prospect.PEPS || prospect.visuals?.genericHeadName || null;

  // CRITICAL FIX: Ensure newPEPS is a string before calling .toUpperCase()
  if (newPEPS !== null && newPEPS !== undefined && typeof newPEPS !== 'string') {
    console.error(`[M26Writer] ERROR at prospect ${prospectIndex}: PEPS is not a string!`);
    console.error(`  Type: ${typeof newPEPS}, Value:`, newPEPS);
    console.error(`  prospect.PEPS:`, prospect.PEPS, `(type: ${typeof prospect.PEPS})`);
    console.error(`  prospect.visuals?.genericHeadName:`, prospect.visuals?.genericHeadName);
    newPEPS = null; // Reset to null to skip this field
  }

  if (newPEPS !== undefined && newPEPS !== null && typeof newPEPS === 'string') {
    const isGenericAsset = newPEPS.toUpperCase().startsWith('GEN_');

    if (!isGenericAsset) {
      // Real player asset - write to 42-byte binary assetName field
      const assetNameStr = newPEPS.slice(0, 42).padEnd(42, '\0');
      buffer.write(assetNameStr, offset + 0x9E, 42, 'ascii');

      if (prospectIndex === 0) {
        console.log(`[M26Writer] ✓ Writing real asset to binary assetName field: "${newPEPS}"`);
        console.log(`[M26Writer]   Offset: 0x${(offset + 0x9E).toString(16)}, Length: 42 bytes`);
      }
    } else {
      // CRITICAL FIX: Generic assets MUST CLEAR the binary field
      // Otherwise the existing real player asset remains and is loaded on next read
      const emptyAssetName = '\0'.repeat(42);
      buffer.write(emptyAssetName, offset + 0x9E, 42, 'ascii');

      if (prospectIndex === 0) {
        console.log(`[M26Writer] ✓ Cleared binary assetName field for generic face: "${newPEPS}"`);
      }
    }
  } else if (pepsIsExplicitlyEmpty) {
    // PEPS was explicitly set to empty string - clear the binary field
    // This handles converting a real player face to a generic face
    const emptyAssetName = '\0'.repeat(42);
    buffer.write(emptyAssetName, offset + 0x9E, 42, 'ascii');

    if (prospectIndex === 0) {
      console.log(`[M26Writer] ✓ Cleared binary assetName field (PEPS explicitly empty)`);
    }
  }
}

/**
 * Update visual JSON data in the buffer
 * Handles updating PEPS (genericHeadName) and bodyType fields
 * @param {Buffer} buffer - File buffer to write to
 * @param {number} blockStart - Start offset of the 4296-byte block (0x10C8)
 * @param {Object} prospect - Prospect data with PEPS and/or bodyType
 */
function updateM26VisualJSON(buffer, blockStart, prospect) {
  // JSON key order is NOT guaranteed - try multiple possible start patterns
  const JSON_START_MARKERS = [
    Buffer.from('{"bodyType"'),
    Buffer.from('{"genericHeadName"'),
    Buffer.from('{"skinTone"'),
    Buffer.from('{"loadouts"')
  ];

  // Find existing JSON in this block by trying all possible start markers
  let jsonStartIndex = -1;
  for (const marker of JSON_START_MARKERS) {
    const idx = buffer.indexOf(marker, blockStart);
    if (idx !== -1 && idx < blockStart + 0x1000) {
      // Found a valid marker - use the earliest one
      if (jsonStartIndex === -1 || idx < jsonStartIndex) {
        jsonStartIndex = idx;
      }
    }
  }

  console.log(`[M26Writer] updateM26VisualJSON called for block at 0x${blockStart.toString(16)}`);
  console.log(`  PEPS to write: ${prospect.PEPS}`);
  console.log(`  bodyType to write: ${prospect.bodyType}`);
  console.log(`  JSON found at: 0x${jsonStartIndex.toString(16)}`);

  if (jsonStartIndex === -1 || jsonStartIndex >= blockStart + 0x1000) {
    // No visual JSON in this block - CREATE a minimal one
    console.log(`[M26Writer] No JSON found in this block - CREATING new visual JSON`);

    // Determine genericHeadName from prospect data
    // Check multiple sources: visuals.genericHeadName, assignedGenr, PEPS (if it starts with gen_)
    let genericHeadName = prospect.visuals?.genericHeadName || prospect.assignedGenr || null;
    if (!genericHeadName && prospect.PEPS && typeof prospect.PEPS === 'string' && prospect.PEPS.toUpperCase().startsWith('GEN_')) {
      genericHeadName = prospect.PEPS;
    }
    console.log(`[M26Writer] Sources checked - visuals.genericHeadName: ${prospect.visuals?.genericHeadName}, assignedGenr: ${prospect.assignedGenr}, PEPS: ${prospect.PEPS}`);

    // Ensure valid genericHeadName matching skinTone for 3D body skin textures
    const m26ToneFallbacks = {
      1: 'gen_1_B_B_005',
      2: 'gen_2_BMH_S_002',
      3: 'gen_3_B_BD_02',
      4: 'gen_4_BHM_S_01',
      5: 'gen_5_BHM_M_002',
      6: 'gen_6_BHM_BM_004',
      7: 'gen_7_BHM_MG_001',
      8: 'gen_7_BHM_MG_001',
    };
    if (!genericHeadName || typeof genericHeadName !== 'string' || !genericHeadName.toUpperCase().startsWith('GEN_')) {
      const tone = prospect.visuals?.skinTone || prospect.skinTone || prospect.race || 7;
      const safeTone = Math.max(1, Math.min(8, Number(tone) || 7));
      genericHeadName = m26ToneFallbacks[safeTone] || 'gen_7_BHM_MG_001';
    }

    // Extract skinTone from genericHeadName (e.g., "gen_7_B_N_019" -> 7)
    const skinToneMatch = genericHeadName.match(/gen_(\d+)/i);
    const skinTone = skinToneMatch ? parseInt(skinToneMatch[1], 10) : 7;

    // Use prospect's bodyType or default
    const bodyType = prospect.bodyType || prospect.visuals?.bodyType || 'Muscular';

    // Create minimal visual JSON structure
    const minimalVisuals = {
      bodyType: bodyType,
      skinTone: skinTone,
      genericHeadName: genericHeadName,
      loadouts: [
        {
          loadoutType: 'PlayerOnField',
          loadoutElements: [
            { slotType: 'CharacterBodyType', itemAssetName: `${bodyType}_BodyType` }
          ]
        }
      ]
    };

    const newJsonString = JSON.stringify(minimalVisuals);
    console.log(`[M26Writer] Created minimal visuals JSON (${newJsonString.length} bytes): genericHeadName=${genericHeadName}, skinTone=${skinTone}`);

    // Write the new JSON at the start of the block (offset 0)
    // The visual section is the first 0x1000 (4096) bytes of each block
    if (newJsonString.length > 4000) {
      console.error(`[M26Writer] ERROR: Generated JSON too large (${newJsonString.length} bytes)`);
      return;
    }

    // Clear the visual section first (fill with nulls), then write JSON
    buffer.fill(0, blockStart, blockStart + 0x1000);
    buffer.write(newJsonString, blockStart, 'utf8');

    console.log(`[M26Writer] ✓ Created new visual JSON at offset 0x${blockStart.toString(16)}`);
    return; // Done - new JSON created
  }

  // Find the end of the JSON object
  let braceCount = 0;
  let jsonEnd = -1;

  for (let i = jsonStartIndex; i < blockStart + 0x1000; i++) {
    const char = String.fromCharCode(buffer[i]);
    if (char === '{') braceCount++;
    if (char === '}') {
      braceCount--;
      if (braceCount === 0) {
        jsonEnd = i + 1;
        break;
      }
    }
  }

  if (jsonEnd === -1) {
    console.warn('[M26Writer] Could not find end of JSON');
    return;
  }

  // Parse existing JSON
  const jsonString = buffer.toString('utf8', jsonStartIndex, jsonEnd);
  let visuals;

  try {
    visuals = JSON.parse(jsonString);
  } catch (e) {
    console.warn('[M26Writer] Failed to parse existing JSON:', e);
    return;
  }

  // Update fields
  let updated = false;

  // CRITICAL FIX: Check both prospect.PEPS and prospect.visuals.genericHeadName
  // The frontend updates visuals.genericHeadName, so prioritize that
  const logFile = path.join(process.cwd(), 'M26Writer_debug.log');
  const logMsg = `
=== PEPS UPDATE DEBUG ===
prospect.PEPS: ${prospect.PEPS}
prospect.visuals exists: ${!!prospect.visuals}
prospect.visuals.genericHeadName: ${prospect.visuals?.genericHeadName}
existing visuals.genericHeadName: ${visuals.genericHeadName}
`;
  const dlog = (m) => { if (process.env.M26_DEBUG) { try { fs.appendFileSync(logFile, m); } catch (_) { /* ignore */ } } };
  dlog(logMsg);

  console.log(`[M26Writer] PEPS check - prospect.PEPS: ${prospect.PEPS}`);
  console.log(`[M26Writer] PEPS check - prospect.visuals exists: ${!!prospect.visuals}`);
  if (prospect.visuals) {
    console.log(`[M26Writer] PEPS check - prospect.visuals.genericHeadName: ${prospect.visuals.genericHeadName}`);
  }

  // Prioritize prospect.visuals.genericHeadName (face picker sets this), then assignedGenr, then PEPS
  // Note: PEPS is set to empty string for generic faces, so it won't be used here
  let newPEPS = prospect.visuals?.genericHeadName || prospect.assignedGenr || null;
  // If no value found but PEPS is a valid gen_ string, use it
  if (!newPEPS && prospect.PEPS && typeof prospect.PEPS === 'string' && prospect.PEPS.toUpperCase().startsWith('GEN_')) {
    newPEPS = prospect.PEPS;
  }
  console.log(`[M26Writer] GENR sources - visuals.genericHeadName: ${prospect.visuals?.genericHeadName}, assignedGenr: ${prospect.assignedGenr}, PEPS: ${prospect.PEPS}`);

  // CRITICAL FIX: Ensure newPEPS is a string (not a number, object, etc.)
  if (newPEPS !== null && newPEPS !== undefined && typeof newPEPS !== 'string') {
    console.error(`[M26Writer] ERROR: newPEPS is not a string! Type: ${typeof newPEPS}, Value:`, newPEPS);
    console.error(`[M26Writer] prospect.PEPS:`, prospect.PEPS, `(type: ${typeof prospect.PEPS})`);
    console.error(`[M26Writer] prospect.visuals?.genericHeadName:`, prospect.visuals?.genericHeadName, `(type: ${typeof prospect.visuals?.genericHeadName})`);
    newPEPS = null; // Reset to null to skip this field
  }

  if (prospect.PEPS) {
    console.log(`[M26Writer] Using prospect.PEPS: ${newPEPS}`);
    dlog(`Using prospect.PEPS: ${newPEPS}\n`);
  } else if (prospect.visuals?.genericHeadName) {
    console.log(`[M26Writer] Falling back to visuals.genericHeadName: ${newPEPS}`);
    dlog(`Falling back to visuals.genericHeadName: ${newPEPS}\n`);
  }

  if (newPEPS !== undefined && newPEPS !== null && typeof newPEPS === 'string') {
    // CRITICAL: Real assets go to BINARY assetName field (written in writeM26AttributeData)
    // Generic assets go to visuals.genericHeadName JSON field
    // Keep genericHeadName as fallback for real assets too
    const isGenericAsset = newPEPS.toUpperCase().startsWith('GEN_');

    if (isGenericAsset) {
      // Generic face - update genericHeadName in visuals JSON
      console.log(`[M26Writer] ✓ UPDATING genericHeadName (generic): ${visuals.genericHeadName} -> ${newPEPS}`);
      dlog(`✓ UPDATING genericHeadName (generic): ${visuals.genericHeadName} -> ${newPEPS}\n`);
      visuals.genericHeadName = newPEPS;
      updated = true;

      // NOTE: Do NOT set visuals.genericHead for draft classes!
      // Research shows CORRECT draft class files have genericHead: undefined
      // The game uses genericHeadName string only for draft classes
      // Setting genericHead causes face mismatch issues
      if (visuals.genericHead !== undefined) {
        console.log(`[M26Writer] Removing genericHead from visuals (was ${visuals.genericHead})`);
        dlog(`Removing genericHead from visuals (was ${visuals.genericHead})\n`);
        delete visuals.genericHead;
      }
    } else {
      // Real player asset - goes to BINARY field, keep genericHeadName as fallback
      console.log(`[M26Writer] ✓ Real asset "${newPEPS}" written to binary field, keeping genericHeadName: ${visuals.genericHeadName}`);
      dlog(`✓ Real asset "${newPEPS}" written to binary field, keeping genericHeadName: ${visuals.genericHeadName}\n`);
      // Don't modify visuals JSON for real assets - they go to binary field only
    }
  } else {
    console.log(`[M26Writer] ✗ NO PEPS VALUE TO UPDATE (newPEPS is ${newPEPS})`);
    dlog(`✗ NO PEPS VALUE TO UPDATE (newPEPS is ${newPEPS})\n`);
  }

  if (prospect.bodyType !== undefined && prospect.bodyType !== null) {
    console.log(`[M26Writer] Updating bodyType: ${visuals.bodyType} -> ${prospect.bodyType}`);
    visuals.bodyType = prospect.bodyType;
    updated = true;

    // CRITICAL: Also update the loadout itemAssetName that references body type
    // The game reads body type from "Heavy_BodyType", "Muscular_BodyType", etc.
    // in the loadouts, not just from the top-level bodyType field
    const bodyTypeAssetName = `${prospect.bodyType}_BodyType`;
    if (visuals.loadouts && Array.isArray(visuals.loadouts)) {
      for (const loadout of visuals.loadouts) {
        if (loadout.loadoutElements && Array.isArray(loadout.loadoutElements)) {
          for (const element of loadout.loadoutElements) {
            if (element.slotType === 'CharacterBodyType' ||
                (element.itemAssetName && element.itemAssetName.endsWith('_BodyType'))) {
              const oldAssetName = element.itemAssetName;
              element.itemAssetName = bodyTypeAssetName;
              console.log(`[M26Writer] Updated loadout bodyType: ${oldAssetName} -> ${bodyTypeAssetName}`);
            }
          }
        }
      }
    }
  }

  // CRITICAL FIX: Update skinTone to match the face category
  // When a generic face is selected (e.g., gen_1_B_N_03), the skinTone should match (1)
  // This ensures the body skin tone matches the face
  let skinToneToUse = null;

  // Priority 1: Use explicit skinTone from prospect.visuals
  if (prospect.visuals && prospect.visuals.skinTone !== undefined && prospect.visuals.skinTone !== null) {
    skinToneToUse = prospect.visuals.skinTone;
  }
  // Priority 2: Extract from genericHeadName if it's a generic face
  else if (newPEPS && typeof newPEPS === 'string' && newPEPS.toUpperCase().startsWith('GEN_')) {
    // Extract skin tone from face name: "gen_7_B_N_019" -> 7
    const match = newPEPS.match(/gen_(\d+)/i);
    if (match) {
      skinToneToUse = parseInt(match[1], 10);
      console.log(`[M26Writer] Extracted skinTone ${skinToneToUse} from genericHeadName "${newPEPS}"`);
    }
  }

  if (skinToneToUse !== null && skinToneToUse !== visuals.skinTone) {
    const oldSkinTone = visuals.skinTone;
    visuals.skinTone = skinToneToUse;
    console.log(`[M26Writer] Updating skinTone: ${oldSkinTone} -> ${skinToneToUse}`);
    updated = true;
  }

  // CRITICAL FIX: Ensure visuals.genericHeadName matches skinToneToUse
  // In Madden 26, body skin (hands, arms, legs) is derived from genericHeadName.
  // If a real player asset was used and genericHeadName in the template slot has a different
  // tone prefix (e.g., template was gen_2 White, player is Black skinTone 7), we must update
  // genericHeadName to a tone-matched generic head so arms/hands match the face.
  if (skinToneToUse !== null) {
    const curToneMatch = visuals.genericHeadName ? String(visuals.genericHeadName).match(/^gen_(\d+)/i) : null;
    const curTone = curToneMatch ? parseInt(curToneMatch[1], 10) : null;
    if (curTone !== skinToneToUse) {
      const m26ToneFallbacks = {
        1: 'gen_1_B_B_005',
        2: 'gen_2_BMH_S_002',
        3: 'gen_3_B_BD_02',
        4: 'gen_4_BHM_S_01',
        5: 'gen_5_BHM_M_002',
        6: 'gen_6_BHM_BM_004',
        7: 'gen_7_BHM_MG_001',
        8: 'gen_7_BHM_MG_001',
      };
      const fallbackHead = m26ToneFallbacks[skinToneToUse] || 'gen_7_BHM_MG_001';
      console.log(`[M26Writer] Updating genericHeadName to match skinTone ${skinToneToUse}: ${visuals.genericHeadName} -> ${fallbackHead}`);
      visuals.genericHeadName = fallbackHead;
      updated = true;
    }
  }

  // EQUIPMENT: Apply equipment loadout changes from prospect.visuals.loadouts
  // The frontend updates prospect.visuals.loadouts with equipment edits
  // We need to merge those into the parsed visuals JSON before re-serializing
  if (prospect.visuals && prospect.visuals.loadouts && Array.isArray(prospect.visuals.loadouts)) {
    console.log(`[M26Writer] Checking for equipment loadout updates...`);

    // Find the PlayerOnField loadout in both source and target
    const sourceLoadouts = prospect.visuals.loadouts;
    const targetLoadouts = visuals.loadouts || [];

    for (const sourceLoadout of sourceLoadouts) {
      // Process all loadouts, but prioritize PlayerOnField for equipment
      if (!sourceLoadout.loadoutElements || !Array.isArray(sourceLoadout.loadoutElements)) continue;

      // Find matching loadout in target by loadoutType (if it exists)
      let targetLoadout = null;
      const sourceType = sourceLoadout.loadoutType;

      if (sourceType) {
        targetLoadout = targetLoadouts.find(l => l.loadoutType === sourceType);
      }

      // If no loadoutType or no match, use the first loadout
      if (!targetLoadout && targetLoadouts.length > 0) {
        targetLoadout = targetLoadouts[0];
      }

      if (!targetLoadout) {
        // No target loadout - create PlayerOnField loadout (required for game to read equipment)
        targetLoadout = {
          loadoutType: 'PlayerOnField',
          outfitType: 'Field',
          loadoutElements: []
        };
        if (!visuals.loadouts) visuals.loadouts = [];
        visuals.loadouts.push(targetLoadout);
        console.log(`[M26Writer] Created new PlayerOnField loadout`);
      }

      if (!targetLoadout.loadoutElements) {
        targetLoadout.loadoutElements = [];
      }

      // Merge equipment elements from source to target
      for (const sourceElement of sourceLoadout.loadoutElements) {
        // Skip CharacterBodyType - handled above
        if (sourceElement.slotType === 'CharacterBodyType') continue;
        if (sourceElement.itemAssetName && sourceElement.itemAssetName.endsWith('_BodyType')) continue;

        // Removal marker: drop the donor's element for this slot (era gear says
        // "no sleeves / no mouthpiece" - the game expresses none by absence).
        if (sourceElement.remove && sourceElement.slotType) {
          const before = targetLoadout.loadoutElements.length;
          targetLoadout.loadoutElements = targetLoadout.loadoutElements.filter((t) => t.slotType !== sourceElement.slotType);
          if (targetLoadout.loadoutElements.length !== before) updated = true;
          continue;
        }

        if (!sourceElement.itemAssetName) continue;

        // For facemasks (no slotType), identify by GearFaceMask_ prefix
        if (!sourceElement.slotType && sourceElement.itemAssetName.startsWith('GearFaceMask_')) {
          // Find or create facemask element (elements without slotType that have GearFaceMask_)
          let found = false;
          for (const targetElement of targetLoadout.loadoutElements) {
            if (!targetElement.slotType && targetElement.itemAssetName && targetElement.itemAssetName.startsWith('GearFaceMask_')) {
              const oldValue = targetElement.itemAssetName;
              targetElement.itemAssetName = sourceElement.itemAssetName;
              console.log(`[M26Writer] Updated facemask: ${oldValue} -> ${sourceElement.itemAssetName}`);
              found = true;
              updated = true;
              break;
            }
          }
          if (!found) {
            targetLoadout.loadoutElements.push({ itemAssetName: sourceElement.itemAssetName });
            console.log(`[M26Writer] Added new facemask: ${sourceElement.itemAssetName}`);
            updated = true;
          }
          continue;
        }

        // For elements with slotType, match by slotType
        if (sourceElement.slotType) {
          let found = false;
          for (const targetElement of targetLoadout.loadoutElements) {
            if (targetElement.slotType === sourceElement.slotType) {
              const oldValue = targetElement.itemAssetName;
              targetElement.itemAssetName = sourceElement.itemAssetName;
              if (oldValue !== sourceElement.itemAssetName) {
                console.log(`[M26Writer] Updated ${sourceElement.slotType}: ${oldValue} -> ${sourceElement.itemAssetName}`);
                updated = true;
              }
              found = true;
              break;
            }
          }
          if (!found) {
            targetLoadout.loadoutElements.push({
              slotType: sourceElement.slotType,
              itemAssetName: sourceElement.itemAssetName
            });
            console.log(`[M26Writer] Added new ${sourceElement.slotType}: ${sourceElement.itemAssetName}`);
            updated = true;
          }
        }
      }
    }
  }

  if (!updated) {
    console.log(`[M26Writer] No updates needed for this prospect`);
    return;
  }

  // Re-serialize JSON
  const newJsonString = JSON.stringify(visuals);
  const newJsonBuffer = Buffer.from(newJsonString, 'utf8');

  // Find actual available space INCLUDING null padding after JSON
  // Madden pads JSON with 0x00 bytes - we can use this space for longer values
  let paddingEnd = jsonEnd;
  for (let i = jsonEnd; i < blockStart + 0x1000; i++) {
    if (buffer[i] === 0x00) {
      paddingEnd++;
    } else {
      break; // Stop at first non-null byte (start of attribute data)
    }
  }

  const availableSpace = paddingEnd - jsonStartIndex;

  dlog(`Old JSON length: ${jsonEnd - jsonStartIndex}\n`);
  dlog(`Padding bytes: ${paddingEnd - jsonEnd}\n`);
  dlog(`Total available space: ${availableSpace}\n`);
  dlog(`New JSON length: ${newJsonBuffer.length}\n`);

  console.log(`[M26Writer] Old JSON: ${jsonEnd - jsonStartIndex} bytes, Padding: ${paddingEnd - jsonEnd} bytes, Total available: ${availableSpace}`);
  console.log(`[M26Writer] New JSON length: ${newJsonBuffer.length}`);

  if (newJsonBuffer.length > availableSpace) {
    console.warn('[M26Writer] ⚠️  NEW JSON TOO LARGE - SKIPPING UPDATE ⚠️');
    console.warn(`  Available (including padding): ${availableSpace}, Needed: ${newJsonBuffer.length}`);
    console.warn(`  Difference: ${newJsonBuffer.length - availableSpace} bytes over`);
    return;
  }

  console.log(`[M26Writer] ✓ JSON fits! Writing to buffer...`);

  // Write new JSON and pad with zeros
  buffer.write(newJsonString, jsonStartIndex, newJsonBuffer.length, 'utf8');

  // Zero out remaining space (including old padding) to prevent garbage data
  for (let i = jsonStartIndex + newJsonBuffer.length; i < paddingEnd; i++) {
    buffer[i] = 0x00;
  }

  console.log(`[M26Writer] ✓ Successfully wrote updated JSON`);
  dlog(`✓ Successfully wrote ${newJsonBuffer.length} bytes, padded ${paddingEnd - (jsonStartIndex + newJsonBuffer.length)} bytes with zeros\n`);
}

module.exports = {
  writeM26DraftClass,
  writeM26AttributeData
};
