import { Router } from 'express';
import { PlayerLookupService } from '../services/PlayerLookupService';
import { DraftClassBuilder, GenOptions, parseGenMode } from '../services/DraftClassBuilder';
import { ProspectVarianceService, type FreakPreset } from '../services/ProspectVarianceService';
import { DbPositionService } from '../services/DbPositionService';
import { gameOverall, reconcileToTarget } from '../services/AttributeModel';
import { TeamService, PickEnrichment } from '../services/TeamService';
import { WikipediaTeamService } from '../services/WikipediaTeamService';
import { enrichedClass, allTimeGreatsClass, pickedClass, boardClass, validateCustomPlayer, teamGreatsClass, parseBoard } from '../services/DraftEnrichment';
import { TeamDraftService } from '../services/TeamDraftService';
import { classSlug } from '../services/ClassName';
import { normalizeName } from '../util/csv';
import { DraftClassResponse } from '../types/player';
import type { PreviewResult } from '../services/DraftClassBuilder';
import { recomputeBatch, RecomputeItem } from '../services/RecomputeService';

const r = Router();

/** Attach the drafting team to each preview row: 1980+ from nflverse by pick,
 *  2026 from Wikipedia, pre-1980 from Wikipedia by name. (Post-generation.) */
async function attachTeams(preview: PreviewResult, year: number, enrich: Map<number, PickEnrichment>): Promise<void> {
  if (enrich.size) {
    for (const row of preview.rows) {
      const t = (row.draftPick != null ? enrich.get(row.draftPick)?.team : undefined) ?? row.supplemental?.team ?? undefined;
      if (t) row.team = t;
    }
  } else if (year === 2026) {
    const t2026 = TeamService.teams2026();
    for (const row of preview.rows) {
      const t = row.draftPick != null ? t2026.get(row.draftPick) : undefined;
      if (t) row.team = t;
    }
  } else if (year < 1980 && year > 0) {
    const wikiTeams = await WikipediaTeamService.teamsByName(year);
    if (wikiTeams.size) {
      for (const row of preview.rows) {
        const t = WikipediaTeamService.teamFor(wikiTeams, row.firstName, row.lastName, row.college);
        if (t) row.team = t;
      }
    }
  }
}

r.get('/draft/years', (_req, res) => {
  res.json({ years: PlayerLookupService.years() }); // 2026 = the real draft, now in the lookup
});

/** Generated class as JSON (wAV-driven OVR, dev trait, face) for the UI. */
/** `include`: source-row indexes to force into an over-capacity year — a JSON
 *  array or a comma list in the query string. */
function parseInclude(raw: unknown): number[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  return [...new Set(list.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 0))].slice(0, 402);
}

/** `keys`: stable player keys for a hand-picked class (array or comma list), deduped, <= 402. */
function parseKeys(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  return [...new Set(list.map((x) => String(x).trim()).filter(Boolean))].slice(0, 402);
}

r.get('/draft/:year/generated', async (req, res) => {
  const year = parseInt(req.params.year, 10);
  if (Number.isNaN(year)) return res.status(400).json({ error: 'invalid year' });
  const isMergeEra = year >= 1960 && year <= 1966; // separate AFL and NFL drafts; 1967-69 were one common draft
  const league = (req.query.league as string) || (isMergeEra ? 'combined' : 'NFL');
  const mode = parseGenMode(req.query.mode);
  const gameVersion: 'm26' | 'm27' = req.query.gameVersion === 'm27' ? 'm27' : 'm26';
  const fill = req.query.fill !== '0'; // pad to a full class by default
  const include = parseInclude(req.query.include);

  // Baseline players with DB positions corrected + per-pick team map (shared with
  // the .mdc export so the file matches this preview exactly).
  const { players, enrich, generatedCount } = await enrichedClass(year, league, { fill });
  if (!players.length) return res.status(404).json({ error: `no players for ${year}` });

  const preview = DraftClassBuilder.preview(players, mode, { include }, gameVersion);
  await attachTeams(preview, year, enrich);
  // Degraded until the depth-chart caches are built (first run): positions for
  // 2001+ DBs/OL are uncorrected, so the client must not cache this as final.
  const degraded = !DbPositionService.isReady();
  return res.json({ year, league, mode, gameVersion, generatedCount, degraded, ...preview });
});

/** Custom class generation: All-Time Greats source and/or generation modifiers
 *  (strength / studs / generational). Not cached server-side; the client caches by
 *  its own key. */
/**
 * What the game will show for an edited prospect. Madden recomputes the overall
 * from the attributes on import, and a bare overall/position/archetype edit makes
 * the export re-solve the skill attributes (applyEdits) - so the profile asks here
 * for the reconciled attributes and the game's overall instead of guessing.
 */
r.post('/draft/recompute', (req, res) => {
  const b = (req.body ?? {}) as { gameVersion?: string; positionId?: number; archetype?: number; overall?: number; ratings?: Record<string, number>; reconcile?: boolean };
  const gameVersion: 'm26' | 'm27' = b.gameVersion === 'm27' ? 'm27' : 'm26';
  const posId = Number(b.positionId) || 0;
  const archetype = Number(b.archetype) || 0;
  const ratings: Record<string, number> = {};
  for (const [k, v] of Object.entries(b.ratings ?? {})) ratings[k] = Math.max(0, Math.min(99, Number(v) || 0));
  const before = gameOverall(ratings, posId, archetype, gameVersion);
  let reconciled: Record<string, number> | null = null;
  if (b.reconcile && b.overall != null) {
    reconciled = { ...ratings };
    reconcileToTarget(reconciled, posId, archetype, Number(b.overall), gameVersion);
  }
  const after = reconciled ? gameOverall(reconciled, posId, archetype, gameVersion) : before;
  // gameArchetype: the archetype the game will label the prospect with (may differ
  // from the one set when another formula scores the same attributes higher).
  res.json({ gameOverall: after.overall, gameArchetype: after.archetype, beforeReconcile: before.overall, reconciled });
});

/** Board-wide version of /recompute: the game's overall for every edited prospect
 *  in one call, so the OVR column and sort reflect attribute edits. */
r.post('/draft/recompute-batch', (req, res) => {
  const b = (req.body ?? {}) as { gameVersion?: string; items?: RecomputeItem[] };
  const gameVersion: 'm26' | 'm27' = b.gameVersion === 'm27' ? 'm27' : 'm26';
  const items = Array.isArray(b.items) ? b.items.slice(0, 402) : [];
  res.json({ results: recomputeBatch(items, gameVersion) });
});

/** The 32 franchises a "By team" class can be built for. */
r.get('/draft/franchises', (_req, res) => {
  res.json({ franchises: TeamDraftService.list() });
});

r.get(['/draft/outliers/calibration', '/draft/freaks/calibration'], (_req, res) => {
  res.json(ProspectVarianceService.getHistoricalCalibrationSummary());
});

r.post('/draft/custom', async (req, res) => {
  const b = (req.body ?? {}) as {
    source?: 'year' | 'alltime' | 'decade' | 'picked' | 'team' | 'freaks'; year?: number; decade?: number; league?: string; mode?: string;
    strength?: number; studs?: number; generational?: boolean; gameVersion?: string; hindsight?: number | string; autoStrength?: boolean; variant?: number; include?: unknown;
    keys?: unknown; fill?: unknown; name?: unknown; board?: unknown; team?: unknown;
    freakMode?: boolean; freakPreset?: FreakPreset; freakRate?: number; freakCap?: number;
    generationalShare?: number; hybridRate?: number; superFusionRate?: number; freakSeed?: number;
  };
  const mode = parseGenMode(b.mode);
  const gameVersion: 'm26' | 'm27' = b.gameVersion === 'm27' ? 'm27' : 'm26';
  const opts: GenOptions = {
    strength: Number(b.strength) > 0 ? Number(b.strength) : 1,
    studs: Math.max(0, Math.round(Number(b.studs) || 0)),
    generational: !!b.generational,
    hindsight: b.hindsight != null && b.hindsight !== '' ? Math.max(0, Math.min(1, Number(b.hindsight))) : 1,
    autoStrength: !!b.autoStrength,
    variant: Math.max(0, Math.round(Number(b.variant) || 0)),
    include: parseInclude(b.include),
    freakMode: !!b.freakMode || b.source === 'freaks',
    freakPreset: b.freakPreset,
    freakRate: b.freakRate != null ? Number(b.freakRate) : undefined,
    freakCap: b.freakCap != null ? Number(b.freakCap) : undefined,
    generationalShare: b.generationalShare != null ? Number(b.generationalShare) : undefined,
    hybridRate: b.hybridRate != null ? Number(b.hybridRate) : undefined,
    superFusionRate: b.superFusionRate != null ? Number(b.superFusionRate) : undefined,
    freakSeed: b.freakSeed != null ? Number(b.freakSeed) : undefined,
  };

  if (b.source === 'freaks') {
    const freakSettings = {
      enabled: true,
      preset: b.freakPreset,
      freakRate: b.freakRate != null ? Number(b.freakRate) : undefined,
      freakCap: b.freakCap != null ? Number(b.freakCap) : undefined,
      generationalShare: b.generationalShare != null ? Number(b.generationalShare) : undefined,
      hybridRate: b.hybridRate != null ? Number(b.hybridRate) : undefined,
      superFusionRate: b.superFusionRate != null ? Number(b.superFusionRate) : undefined,
      seed: b.freakSeed != null ? Number(b.freakSeed) : (opts.variant ? opts.variant * 1000 + 2027 : 2027),
    };
    const players = ProspectVarianceService.buildProceduralClass(freakSettings, 2027);
    const preview = DraftClassBuilder.preview(players, mode, { ...opts, freakMode: true }, gameVersion);
    return res.json({ year: 2027, league: 'Outlier Engine', mode, gameVersion, source: 'freaks', name: 'Outlier Engine Class', generatedCount: 0, ...preview });
  }

  if (b.source === 'picked') {
    // A Class Studio board (real keys and custom prospects in pick order), or the
    // 1.2.0 shape: a list of keys, treated as a board in that order.
    const board = parseBoard(b.board) ?? parseKeys(b.keys).map((key) => ({ key }));
    if (!board.length) return res.status(400).json({ error: 'no players picked' });
    for (const e of board) {
      if ('custom' in e) { const why = validateCustomPlayer(e.custom); if (why) return res.status(400).json({ error: why }); }
    }
    const { players, generatedCount, missing, truncatedKeys } = await boardClass(board, { fill: b.fill !== false });
    if (!players.length) return res.status(404).json({ error: 'none of the picked players were found' });
    const preview = DraftClassBuilder.preview(players, mode, opts, gameVersion);
    const name = String(b.name ?? '').slice(0, 60);
    // The client re-keys `league` to its saved class id so edits follow the class,
    // not its current name.
    return res.json({ year: 0, league: `custom:${classSlug(name)}`, mode, gameVersion, source: 'picked', name, generatedCount, missing, truncatedKeys, pickedCount: players.length - generatedCount, ...preview });
  }

  if (b.source === 'team') {
    // A franchise's all-time draft: the best players it ever drafted, every era.
    const team = TeamDraftService.get(String(b.team ?? ''));
    if (!team) return res.status(400).json({ error: 'unknown team' });
    const { players, generatedCount } = await teamGreatsClass(team.key);
    if (!players.length) return res.status(404).json({ error: 'no players' });
    const preview = DraftClassBuilder.preview(players, mode, opts, gameVersion);
    const badge = { abbr: team.key, name: team.name, logo: team.logo };
    for (const row of preview.rows) if (row.draftPick != null || row.supplemental) row.team = badge;
    return res.json({ year: 0, league: `team:${team.key}`, mode, gameVersion, source: 'team', name: team.name, team, generatedCount, ...preview });
  }

  if (b.source === 'alltime' || b.source === 'decade') {
    const decade = Math.floor(Number(b.decade) / 10) * 10;
    const range = b.source === 'decade' && decade > 0 ? { from: decade, to: decade + 9 } : undefined;
    const { players, generatedCount } = await allTimeGreatsClass(range);
    if (!players.length) return res.status(404).json({ error: 'no players' });
    const preview = DraftClassBuilder.preview(players, mode, opts, gameVersion);
    const league = range ? `${decade}s` : 'all-time';
    return res.json({ year: range ? decade : 0, league, mode, gameVersion, source: b.source, generatedCount, ...preview });
  }

  const year = parseInt(String(b.year), 10);
  if (Number.isNaN(year)) return res.status(400).json({ error: 'invalid year' });
  const isMergeEra = year >= 1960 && year <= 1966; // separate AFL and NFL drafts; 1967-69 were one common draft
  const league = b.league || (isMergeEra ? 'combined' : 'NFL');
  const { players, enrich, generatedCount } = await enrichedClass(year, league, { fill: true });
  if (!players.length) return res.status(404).json({ error: `no players for ${year}` });
  const preview = DraftClassBuilder.preview(players, mode, opts, gameVersion);
  await attachTeams(preview, year, enrich);
  return res.json({ year, league, mode, gameVersion, source: 'year', generatedCount, ...preview });
});

/**
 * Baseline draft class from the local ALL_PLAYER_LOOKUP.csv (offline, no
 * scraping). Live sourcing/enrichment is layered on top in a later task.
 */
r.get('/draft/:year', (req, res) => {
  const year = parseInt(req.params.year, 10);
  if (Number.isNaN(year)) {
    return res.status(400).json({ error: 'invalid year' });
  }
  const isMergeEra = year >= 1960 && year <= 1966; // separate AFL and NFL drafts; 1967-69 were one common draft
  const league = (req.query.league as string) || (isMergeEra ? 'combined' : 'NFL');
  const prospects = PlayerLookupService.byYear(year, league);
  const drafted = prospects.filter((p) => p.draftRound != null).length;

  const body: DraftClassResponse = {
    year,
    league,
    source: 'local',
    degraded: false,
    counts: {
      drafted,
      undrafted: prospects.length - drafted,
      freeAgents: 0,
      total: prospects.length,
    },
    prospects,
    freeAgents: [],
  };
  return res.json(body);
});

export default r;
