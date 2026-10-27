import { Router } from 'express';
import type { BaselinePlayer } from '../types/player';
import fs from 'fs';
import path from 'path';
import { DraftClassBuilder, GenOptions, parseGenMode } from '../services/DraftClassBuilder';
import { ProspectVarianceService, type FreakPreset } from '../services/ProspectVarianceService';
import { PortraitModService } from '../services/PortraitModService';
import { PortraitPackService } from '../services/PortraitPackService';
import { FranchiseService } from '../services/FranchiseService';
import { M27_SAVES_DIR } from '../config/paths';
import { enrichedClass, allTimeGreatsClass, boardClass, teamGreatsClass, parseBoard } from '../services/DraftEnrichment';
import { TeamDraftService } from '../services/TeamDraftService';
import { OpenedClassService } from '../services/OpenedClassService';
import { classSlug } from '../services/ClassName';

const r = Router();

/**
 * Build and download an importable .mdc draft class for a year (local baseline).
 * POST body may pass already-edited prospects later; for now it sources from
 * the local lookup by year. Ratings are wAV-driven; the full reconciliation
 * engine refines attribute spreads in a later task.
 */
r.post('/export/mdc', async (req, res) => {
  const edits = req.body?.edits as Record<string, Record<string, number | string>> | undefined;
  const gearEdits = req.body?.gearEdits as Record<string, Record<string, string>> | undefined;
  const mode = parseGenMode(req.body?.mode);
  const gameVersion: 'm26' | 'm27' = req.body?.gameVersion === 'm27' ? 'm27' : 'm26';
  const source = req.body?.source === 'freaks' ? 'freaks' : req.body?.source === 'alltime' ? 'alltime' : req.body?.source === 'decade' ? 'decade' : req.body?.source === 'picked' ? 'picked' : req.body?.source === 'team' ? 'team' : req.body?.source === 'file' ? 'file' : 'year';
  const opts: GenOptions = {
    strength: Number(req.body?.strength) > 0 ? Number(req.body?.strength) : 1,
    studs: Math.max(0, Math.round(Number(req.body?.studs) || 0)),
    generational: !!req.body?.generational,
    hindsight: req.body?.hindsight != null && req.body?.hindsight !== '' ? Math.max(0, Math.min(1, Number(req.body.hindsight))) : 1,
    autoStrength: !!req.body?.autoStrength,
    variant: Math.max(0, Math.round(Number(req.body?.variant) || 0)),
    include: (Array.isArray(req.body?.include) ? req.body.include : []).map((x: unknown) => Number(x)).filter((n: number) => Number.isInteger(n) && n >= 0),
    portraitPack: !!req.body?.portraitPack,
    portraitCdn: !!req.body?.portraitCdn,
    freakMode: !!req.body?.freakMode || source === 'freaks',
    freakPreset: req.body?.freakPreset as FreakPreset | undefined,
    freakRate: req.body?.freakRate != null ? Number(req.body.freakRate) : undefined,
    freakCap: req.body?.freakCap != null ? Number(req.body.freakCap) : undefined,
    generationalShare: req.body?.generationalShare != null ? Number(req.body.generationalShare) : undefined,
    hybridRate: req.body?.hybridRate != null ? Number(req.body.hybridRate) : undefined,
    superFusionRate: req.body?.superFusionRate != null ? Number(req.body.superFusionRate) : undefined,
    freakSeed: req.body?.freakSeed != null ? Number(req.body.freakSeed) : undefined,
  };

  // An opened .mdc: apply the edits to the file's own prospects and write them
  // back into a copy of the original bytes, in the game format it came in.
  let fileOut: { buffer: Buffer; filename: string; gameVersion: 'm26' | 'm27'; count: number } | null = null;
  if (source === 'file') {
    fileOut = OpenedClassService.write(String(req.body?.fileId ?? ''), edits, gearEdits);
    if (!fileOut) return res.status(404).json({ error: 'that opened class is gone — open the file again' });
  }

  let players: BaselinePlayer[] = []; let filename: string;
  if (fileOut) {
    players = [];
    filename = fileOut.filename;
    } else if (source === 'freaks') {
    const freakSettings = {
      enabled: true,
      preset: opts.freakPreset,
      freakRate: opts.freakRate,
      freakCap: opts.freakCap,
      generationalShare: opts.generationalShare,
      hybridRate: opts.hybridRate,
      superFusionRate: opts.superFusionRate,
      seed: opts.freakSeed ?? (opts.variant ? opts.variant * 1000 + 2027 : 2027),
    };
    players = ProspectVarianceService.buildProceduralClass(freakSettings, 2027);
    filename = `CAREERDRAFT-OUTLIERS${freakSettings.seed}`;
  } else if (source === 'picked') {
    // A Class Studio board in pick order, or the 1.2.0 shape (a list of keys).
    const raw = req.body?.keys;
    const keys = [...new Set((Array.isArray(raw) ? raw : []).map((x: unknown) => String(x).trim()).filter(Boolean))].slice(0, 402) as string[];
    const board = parseBoard(req.body?.board) ?? keys.map((key) => ({ key }));
    if (!board.length) return res.status(400).json({ error: 'no players picked' });
    ({ players } = await boardClass(board, { fill: req.body?.fill !== false }));
    filename = `CAREERDRAFT-${classSlug(String(req.body?.name ?? ''))}`;
  } else if (source === 'team') {
    const team = TeamDraftService.get(String(req.body?.team ?? ''));
    if (!team) return res.status(400).json({ error: 'unknown team' });
    ({ players } = await teamGreatsClass(team.key));
    filename = `CAREERDRAFT-${classSlug(`${team.name} All-Time`)}`;
  } else if (source === 'alltime' || source === 'decade') {
    const decade = Math.floor(Number(req.body?.decade) / 10) * 10;
    const range = source === 'decade' && decade > 0 ? { from: decade, to: decade + 9 } : undefined;
    ({ players } = await allTimeGreatsClass(range));
    filename = range ? `CAREERDRAFT-${decade}sGREATS` : 'CAREERDRAFT-ALLTIMEGREATS';
  } else {
    const year = parseInt(String(req.body?.year ?? req.query.year), 10);
    if (Number.isNaN(year)) return res.status(400).json({ error: 'year is required' });
    const isMergeEra = year >= 1960 && year <= 1969;
    const league = String(req.body?.league ?? req.query.league ?? (isMergeEra ? 'combined' : 'NFL'));
    const fill = req.body?.fill !== false; // matches the preview (full class) by default
    ({ players } = await enrichedClass(year, league, { fill }));
    filename = `CAREERDRAFT-${year}DRAFT`;
  }
  if (!fileOut && players.length === 0) {
    return res.status(404).json({ error: 'no players found' });
  }

  const outGame: 'm26' | 'm27' = fileOut ? fileOut.gameVersion : gameVersion;
  const built = fileOut
    ? { buffer: fileOut.buffer, count: fileOut.count, truncated: false, dropped: [] as { firstName: string; lastName: string }[], likeness: { asset: 0, generic: 0, withPortrait: 0, customPortrait: 0 }, portraitPack: undefined, portraitPackMissing: undefined }
    : outGame === 'm27'
      ? DraftClassBuilder.buildMdc27(players, edits, mode, gearEdits, opts)
      : DraftClassBuilder.buildMdc(players, edits, mode, gearEdits, opts);
  const { buffer, count, truncated, dropped, likeness } = built;
  // The portrait pack folder for the ids the class just wrote (M27 only).
  const pack = built.portraitPack ? await PortraitPackService.write(built.portraitPack, PortraitPackService.dirFor(filename), built.portraitPackMissing ?? []) : null;

  // saveToSaves: write the class straight into the Madden Saves folder (the name
  // is already Madden's CAREERDRAFT-* convention) so it shows up in Franchise →
  // Choose Draft Class without a manual file move. Overwrites our own previous
  // export of the same class intentionally.
  if (req.body?.saveToSaves) {
    const dir = outGame === 'm27' ? M27_SAVES_DIR : FranchiseService.savesDir();
    if (!fs.existsSync(dir)) return res.status(400).json({ error: `Madden Saves folder not found: ${dir}` });
    const outPath = path.join(dir, filename);
    // Never leave a half-written class in the Saves folder: write a temp file
    // next to it and rename over the target; keep the previous export as .bak
    // (the game ignores files with an extension) and say that we overwrote.
    const overwrote = fs.existsSync(outPath);
    const tmp = `${outPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, buffer);
    if (overwrote) fs.copyFileSync(outPath, `${outPath}.bak`);
    fs.renameSync(tmp, outPath);
    return res.json({ saved: true, path: outPath, filename, count, truncated, dropped: dropped.length, likeness, overwrote, backup: overwrote ? `${outPath}.bak` : null, gameVersion: outGame, portraitPack: pack });
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Prospect-Count', String(count));
  res.setHeader('X-Game-Version', outGame);
  res.setHeader('X-Truncated', truncated ? '1' : '0');
  res.setHeader('X-Likeness-Asset', String(likeness.asset));
  res.setHeader('X-Likeness-Generic', String(likeness.generic));
  res.setHeader('X-Likeness-Portrait', String(likeness.withPortrait));
  res.setHeader('X-Likeness-CustomPortrait', String(likeness.customPortrait));
  if (dropped.length) res.setHeader('X-Dropped-Count', String(dropped.length));
  if (pack) {
    res.setHeader('X-Portrait-Pack-Count', String(pack.count));
    res.setHeader('X-Portrait-Pack-Missing', String(pack.missing));
    res.setHeader('X-Portrait-Pack-Dir', encodeURIComponent(pack.dir));
  }
  return res.send(buffer);
});

/**
 * Write the full Madden 27 portrait pack: every portrait the app holds that the
 * game no longer ships (about 5,100), named by the player's own id, for one
 * import with the MMC Portrait Manager. Files already written are kept unless
 * `?force=1`.
 */
r.post('/export/portrait-pack/all', async (req, res) => {
  try {
    const result = await PortraitPackService.writeFull({ force: req.query.force === '1' });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * Build a Frosty-import custom-portrait folder for a year: downloads real
 * photos for prospects who have no in-game face, crops them, names each by the
 * recycled PLPO slot, and writes a manifest. The matching .mdc already points
 * those prospects at the same slot's PID. `?limit=N` caps downloads (testing).
 */
r.post('/export/portraits/:year', async (req, res) => {
  const year = parseInt(req.params.year, 10);
  if (Number.isNaN(year)) return res.status(400).json({ error: 'invalid year' });
  const isMergeEra = year >= 1960 && year <= 1969;
  const league = String(req.query.league ?? (isMergeEra ? 'combined' : 'NFL'));
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
  try {
    const result = await PortraitModService.buildForYear(year, league, {
      limit,
      nowIso: new Date().toISOString(),
    });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
});

export default r;
