import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ArchetypeOption } from './api';
import { cache, setGeneratorFingerprint } from './cache';
import { ClassStudio } from './components/ClassStudio';
import { OpenClass } from './components/OpenClass';
import { MenuBar } from './components/MenuBar';
import type { ExportActions } from './components/ExportMenu';
import { ClassView } from './components/ClassView';
import { DroppedPanel } from './components/DroppedPanel';
import { FranchiseView } from './components/franchise/FranchiseView';
import { HomePage } from './components/HomePage';
import { SideRail } from './components/SideRail';
import { RostersView } from './components/rosters/RostersView';
import { TopBar } from './components/TopBar';
import { schedulePrewarm, cancelPrewarm } from './prewarm';
import { UpdateBanner } from './components/UpdateBanner';
import { WhatsNew, useWhatsNew } from './components/WhatsNew';
import { Icon, ICONS } from './components/ui';
import { BoardSkeleton, EmptyBoard } from './components/BoardStates';
import { GamePicker } from './components/GamePicker';
import { productTitle } from './brand';
import type { ClassEdits, CustomClass, GearEdits, GeneratedClass, GameVersion } from './types';

/** Gear edits saved before the thigh slot was merged carry thighLeft/thighRight;
 *  the builder now has one thighPads slot that dresses both legs. */
function normalizeGearPatch(patch: Record<string, string>): Record<string, string> {
  const { thighLeft, thighRight, ...rest } = patch;
  const thigh = thighLeft ?? thighRight;
  return thigh && !rest.thighPads ? { ...rest, thighPads: thigh } : rest;
}
function normalizeGearEdits(gear: GearEdits): GearEdits {
  return Object.fromEntries(Object.entries(gear).map(([id, patch]) => [Number(id), normalizeGearPatch(patch)]));
}

export type AppView = 'home' | 'draft' | 'franchise' | 'rosters';

/** Draft-class generation modifiers (custom classes). */
export interface DraftOpts {
  source: 'year' | 'alltime' | 'decade' | 'picked' | 'team' | 'file' | 'freaks';
  decade: number; // used when source === 'decade' (e.g. 1990)
  team?: string; // franchise key when source === 'team' (e.g. DAL)
  fileId?: string; // an opened .mdc when source === 'file'
  strength: number; // OVR curve multiplier (1 = normal)
  studs: number; // guaranteed first-round-caliber prospects
  generational: boolean; // force a can't-miss #1
  hindsight: number; // 0 = draft-day board (by slot), 1 = career outcome
  autoStrength: boolean; // scale the curve by how good the class really was
  variant: number; // 0 = canonical class; N re-rolls faces/gear/attribute noise
  include?: number[]; // source indexes forced into an over-capacity year (per class, persisted)
  customId?: string; // hand-picked class id (source === 'picked')
  fill?: boolean; // pad a short hand-picked class to 402 (default true)
  freakMode?: boolean;
  freakPreset?: import('./types').FreakPreset;
  freakRate?: number;
  freakCap?: number;
  generationalShare?: number;
  hybridRate?: number;
  superFusionRate?: number;
  freakSeed?: number;
}
export const DEFAULT_DRAFT_OPTS: DraftOpts = { source: 'year', decade: 2010, strength: 1, studs: 0, generational: false, hindsight: 1, autoStrength: false, variant: 0 };
export const isCustomDraft = (o: DraftOpts) =>
  o.source !== 'year' || !!o.freakMode || o.strength !== 1 || o.studs !== 0 || o.generational || (o.hindsight ?? 1) !== 1 || !!o.autoStrength || (o.variant ?? 0) !== 0 || (o.include?.length ?? 0) > 0;

const isMergeEra = (y: number) => y >= 1960 && y <= 1966; // 1967-69: one common draft
const leagueFor = (y: number) => (isMergeEra(y) ? 'combined' : 'NFL');
/** Rating lens: Realistic rookie curve, Career outcome, or EA's launch-day numbers. */
export type GenMode = 'madden' | 'retro' | 'launch';

export default function App() {
  const [years, setYears] = useState<number[]>([]);
  const [cachedYears, setCachedYears] = useState<Set<number>>(new Set());
  // The loader needs the year list to pick neighbours to pre-warm, but adding
  // `years` to its dependency array would rebuild the callback; a ref keeps the
  // deps as they are.
  const yearsRef = useRef<number[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [data, setData] = useState<GeneratedClass | null>(null);
  const [edits, setEdits] = useState<ClassEdits>({});
  const [gearEdits, setGearEdits] = useState<GearEdits>({});
  const [source, setSource] = useState<'cache' | 'live'>('live');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archetypeOptions, setArchetypeOptions] = useState<Record<string, ArchetypeOption[]>>({});
  const [mode, setMode] = useState<GenMode>('madden');
  // The game is chosen once at first run (a per-game build is pinned and never asks).
  const GAME_KEY = 'game:choice';
  const [gameVersion, setGameVersion] = useState<GameVersion>(() => { try { const v = localStorage.getItem(GAME_KEY); return v === 'm26' || v === 'm27' ? v : 'm27'; } catch { return 'm27'; } });
  const [gameChosen, setGameChosen] = useState<boolean>(() => { try { return localStorage.getItem(GAME_KEY) != null; } catch { return true; } });
  const [gamePickerOpen, setGamePickerOpen] = useState(false);
  const [cfgLoaded, setCfgLoaded] = useState(false);
  // Per-game desktop builds pin the target game (no M26/M27 toggle); Franchise
  // Tools only appear when the server enables them (out of the 1.0.0 release).
  const [pinnedGame, setPinnedGame] = useState<GameVersion | null>(null);
  const [franchiseEnabled, setFranchiseEnabled] = useState(false);
  const [view, setView] = useState<AppView>('draft');
  // Opens itself once after an update, and is reachable any time from the bar.
  const [whatsNewOpen, openWhatsNew, closeWhatsNew] = useWhatsNew();
  // The open class's export actions, filled by ExportMenu for the File / Edit menus.
  const exportActionsRef = useRef<ExportActions | null>(null);
  // App version for the Help menu (from the API's about endpoint).
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/about').then((r) => r.json()).then((d: { version?: string }) => setAppVersion(d.version ? `v${d.version}` : null)).catch(() => {});
  }, []);
  const [usedYears, setUsedYears] = useState<Set<number>>(new Set());
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  const [lastDrawn, setLastDrawn] = useState<number | null>(null);
  const [focusPlayer, setFocusPlayer] = useState<string | null>(null);
  const [recentYears, setRecentYears] = useState<number[]>([]);
  // For merge-era (1960–69) years the user can pick AFL+NFL / NFL / AFL; null = default.
  const [leagueOverride, setLeagueOverride] = useState<string | null>(null);
  const [draftOpts, setDraftOpts] = useState<DraftOpts>(DEFAULT_DRAFT_OPTS);
  const [showDropped, setShowDropped] = useState(false);
  // Hand-picked classes: the saved list (for Draft options) and the builder dialog.
  const [customClasses, setCustomClasses] = useState<CustomClass[]>([]);
  const [builder, setBuilder] = useState<{ open: boolean; initial: CustomClass | null }>({ open: false, initial: null });
  const editKeyRef = useRef<{ year: number; league: string } | null>(null);
  const dataRef = useRef<GeneratedClass | null>(null);
  const selectedRef = useRef<number | null>(null);
  // Backend liveness: poll /api/health every 15 s (the dot used to mirror the
  // last request's error state, which said "connected" with the server down).
  const [connected, setConnected] = useState(true);
  const selectRef = useRef<((year: number, force?: boolean) => void) | null>(null);
  useEffect(() => {
    let alive = true;
    const ping = () => fetch('/api/health', { cache: 'no-store' })
      .then(async (r) => {
        if (!alive) return;
        setConnected(r.ok);
        if (!r.ok) return;
        const j = await r.json().catch(() => null);
        const gen = j?.generator as string | undefined;
        if (!gen) return;
        setGeneratorFingerprint(gen);
        // A class opened before this fingerprint arrived can still be the old
        // generated sentences. Rebuild it once the generator is known.
        const shown = dataRef.current;
        const year = selectedRef.current;
        if (shown?._gen && shown._gen !== gen && year != null) selectRef.current?.(year, true);
      })
      .catch(() => alive && setConnected(false));
    ping();
    const t = setInterval(ping, 15000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const editsRef = useRef<ClassEdits>({});
  const gearRef = useRef<GearEdits>({});
  const historyRef = useRef<{ past: Array<{ edits: ClassEdits; gear: GearEdits }>; future: Array<{ edits: ClassEdits; gear: GearEdits }> }>({ past: [], future: [] });
  const reqRef = useRef(0); // guards against a slow earlier response clobbering a newer selection

  const effLeague = useCallback(
    (y: number) => (isMergeEra(y) && leagueOverride ? leagueOverride : leagueFor(y)),
    [leagueOverride]
  );

  const select = useCallback(
    async (year: number, force = false, useMode: GenMode = mode, useLeague?: string, useOpts?: DraftOpts, useVersion: GameVersion = gameVersion) => {
      const baseOpts = useOpts ?? draftOpts;
      // Greats classes key their edits/cache under a fixed pseudo-year / decade label.
      const league = baseOpts.source === 'alltime' ? 'all-time'
        : baseOpts.source === 'freaks' ? 'outlier-engine'
        : baseOpts.source === 'decade' ? `${baseOpts.decade}s`
        : baseOpts.source === 'picked' ? `custom:${baseOpts.customId ?? 'none'}`
        : baseOpts.source === 'team' ? `team:${baseOpts.team ?? 'none'}`
        : baseOpts.source === 'file' ? `file:${baseOpts.fileId ?? 'none'}`
        : useLeague ?? effLeague(year);
      // The include list lives with the class (not the global options): load it for
      // this year so a forced-in player survives re-selecting the year.
      const storedInclude = year > 0 && baseOpts.source === 'year' ? await cache.includeGet(year, league) : [];
      const opts: DraftOpts = { ...baseOpts, include: useOpts?.include ?? storedInclude };
      if ((opts.include?.length ?? 0) !== (baseOpts.include?.length ?? 0)) setDraftOpts(opts);
      const custom = isCustomDraft(opts);
      const ekYear = opts.source === 'freaks' || opts.source === 'alltime' || opts.source === 'picked' || opts.source === 'team' || opts.source === 'file' ? 0 : opts.source === 'decade' ? opts.decade : year;
      // M27 classes are cached under a versioned key so M26/M27 views never collide.
      const cacheMode = useVersion === 'm27' ? `${useMode}-m27` : useMode;
      const req = ++reqRef.current;
      setSelected(year);
      setError(null);
      setBusy(true);
      // Track recently viewed real years for the year picker's "Recent" row.
      if (year > 0 && opts.source === 'year') {
        setRecentYears((prev) => {
          const next = [year, ...prev.filter((y) => y !== year)].slice(0, 8);
          cache.recentYearsSet(next);
          return next;
        });
      }
      try {
        if (opts.source === 'file') {
          // An opened .mdc: the server holds the file; nothing to generate or cache.
          if (!opts.fileId) throw new Error('No file is open');
          const live = await api.openedClass(opts.fileId);
          if (req !== reqRef.current) return;
          live.fetchedAt = Date.now();
          setData(live);
          setSource('live');
          cancelPrewarm();
        } else if (custom) {
          // Custom classes aren't year-cached — always generated fresh.
          // A Class Studio class sends its board in pick order.
          let picked: { board: import('./types').BoardEntry[]; name: string } | undefined;
          if (opts.source === 'picked') {
            const c = opts.customId ? await cache.customGet(opts.customId) : undefined;
            if (!c) throw new Error('That class no longer exists');
            picked = { board: c.board, name: c.name };
          }
          const live = await api.generatedCustom({
            source: opts.source, year, decade: opts.decade, team: opts.team,
            league: opts.source === 'year' ? league : undefined,
            mode: useMode, strength: opts.strength, studs: opts.studs, generational: opts.generational,
            hindsight: opts.hindsight, autoStrength: opts.autoStrength, variant: opts.variant, include: opts.include,
            board: picked?.board, fill: opts.fill !== false, name: picked?.name,
            gameVersion: useVersion,
            freakMode: opts.freakMode, freakPreset: opts.freakPreset, freakRate: opts.freakRate,
            freakCap: opts.freakCap, generationalShare: opts.generationalShare, hybridRate: opts.hybridRate,
            superFusionRate: opts.superFusionRate, freakSeed: opts.freakSeed,
          });
          if (req !== reqRef.current) return;
          live.fetchedAt = Date.now();
          live.gameVersion = useVersion;
          if (picked) live.league = league; // edits key on the saved class id, not its name
          setData(live);
          setSource('live');
          cancelPrewarm();
        } else {
          const cached = force ? undefined : await cache.get(year, league, cacheMode);
          if (req !== reqRef.current) return; // a newer selection superseded this one
          if (cached) {
            cached.gameVersion = useVersion;
            setData(cached);
            setSource('cache');
          } else {
            const live = await api.generated(year, league, useMode, useVersion);
            if (req !== reqRef.current) return;
            live.fetchedAt = Date.now();
            live.gameVersion = useVersion;
            if (!live.degraded) await cache.set(live, cacheMode); // a first-run class is not final
            setData(live);
            setSource('live');
            setCachedYears((prev) => new Set(prev).add(year));
          }
          // This class is on screen now, so the next second is free: build the
          // neighbouring years so stepping through with the arrows is instant
          // instead of paying the first-build cost each time.
          schedulePrewarm({
            year,
            years: yearsRef.current,
            league,
            mode: cacheMode,
            gameVersion: useVersion,
            onCached: (y) => setCachedYears((prev) => new Set(prev).add(y)),
          });
        }
        // Edits are keyed by the class actually shown (Greats classes use a pseudo
        // year / decade label), so every later save must use this same key.
        editKeyRef.current = { year: ekYear, league };
        historyRef.current = { past: [], future: [] };
        const loadedEdits = await cache.editsGet(ekYear, league);
        const loadedGear = normalizeGearEdits(await cache.gearEditsGet(ekYear, league));
        editsRef.current = loadedEdits;
        gearRef.current = loadedGear;
        setEdits(loadedEdits);
        setGearEdits(loadedGear);
      } catch (e) {
        if (req !== reqRef.current) return;
        setError((e as Error).message);
        setData(null);
      } finally {
        if (req === reqRef.current) setBusy(false);
      }
    },
    [mode, effLeague, draftOpts, gameVersion]
  );
  dataRef.current = data;
  selectedRef.current = selected;
  selectRef.current = select;

  /** Force a player the 402-slot class cut back in (or out again). Persisted per
   *  class; the server swaps him into the weakest keeper's slot so other picks hold. */
  const setInclude = useCallback(
    async (next: number[]) => {
      if (selected == null || !data) return;
      const league = data.league;
      await cache.includeSet(selected, league, next);
      const opts = { ...draftOpts, include: next };
      setDraftOpts(opts);
      select(selected, true, mode, league, opts);
    },
    [selected, data, draftOpts, mode, select]
  );
  const onInclude = useCallback((idx: number) => { const cur = draftOpts.include ?? []; if (!cur.includes(idx)) setInclude([...cur, idx]); }, [draftOpts.include, setInclude]);
  const onExclude = useCallback((idx: number) => setInclude((draftOpts.include ?? []).filter((i) => i !== idx)), [draftOpts.include, setInclude]);

  const persistUsed = useCallback((next: Set<number>) => {
    setUsedYears(next);
    cache.usedYearsSet([...next]);
  }, []);

  // Apply draft-class generation options (source + modifiers) and regenerate.
  const applyDraftOpts = useCallback(
    (next: DraftOpts) => {
      setDraftOpts(next);
      setFocusPlayer(null);
      const year =
        next.source === 'freaks' || next.source === 'alltime' || next.source === 'picked' || next.source === 'team' || next.source === 'file' ? 0
        : next.source === 'decade' ? next.decade
        : selected && selected > 0 ? selected : years.includes(2003) ? 2003 : years[years.length - 1] ?? 2003;
      select(year, true, mode, undefined, next);
    },
    [selected, years, mode, select]
  );

  const openOutliers = useCallback(() => {
    setView('draft');
    const next: DraftOpts = {
      ...draftOpts,
      source: 'freaks',
      freakMode: true,
    };
    setDraftOpts(next);
    applyDraftOpts(next);
  }, [draftOpts, applyDraftOpts]);

  const openBuilder = useCallback((c: CustomClass | null) => setBuilder({ open: true, initial: c }), []);

  // Open an existing .mdc: the board shows the file as it is, in its own game.
  const [openerOpen, setOpenerOpen] = useState(false);
  const openedClass = useCallback(
    (cls: GeneratedClass) => {
      setOpenerOpen(false);
      setFocusPlayer(null);
      const v: GameVersion = cls.gameVersion === 'm27' ? 'm27' : 'm26';
      setGameVersion(v);
      const next: DraftOpts = { ...DEFAULT_DRAFT_OPTS, source: 'file', fileId: cls.fileId };
      setDraftOpts(next);
      select(0, true, mode, undefined, next, v);
    },
    [mode, select]
  );
  const closeBuilder = useCallback(() => {
    setBuilder({ open: false, initial: null });
    cache.customList().then(setCustomClasses);
  }, []);
  // Save & generate from the builder: the class is already persisted; show it.
  const generatePicked = useCallback(
    async (c: CustomClass, fill: boolean) => {
      setBuilder({ open: false, initial: null });
      setCustomClasses(await cache.customList());
      applyDraftOpts({ ...draftOpts, source: 'picked', customId: c.id, fill });
    },
    [draftOpts, applyDraftOpts]
  );

  const inRange = useCallback(
    (y: number) => !range || (y >= range.from && y <= range.to),
    [range]
  );

  const updateRange = useCallback(
    (from: number, to: number) => {
      if (!years.length) return;
      const lo = Math.min(...years);
      const hi = Math.max(...years);
      const f = Math.max(lo, Math.min(hi, from));
      const t = Math.max(f, Math.min(hi, to));
      const r = { from: f, to: t };
      setRange(r);
      cache.rangeSet(r);
    },
    [years]
  );

  // Draw a random unused draft year within the selected range, mark it used, and
  // jump to the draft view on that class (ready to export). No-repeat by construction.
  const drawRandomYear = useCallback(() => {
    const pool = years.filter((y) => !usedYears.has(y) && inRange(y));
    if (pool.length === 0) return;
    const year = pool[Math.floor(Math.random() * pool.length)];
    persistUsed(new Set(usedYears).add(year));
    setLastDrawn(year);
    setFocusPlayer(null);
    setView('draft');
    select(year);
  }, [years, usedYears, inRange, persistUsed, select]);

  // Undo the most recent draw — puts that year back in the pool.
  const undoLastDraw = useCallback(() => {
    const arr = [...usedYears];
    if (arr.length === 0) return;
    arr.pop();
    persistUsed(new Set(arr));
    setLastDrawn(null);
  }, [usedYears, persistUsed]);

  const toggleUsedYear = useCallback(
    (year: number) => {
      const next = new Set(usedYears);
      if (next.has(year)) next.delete(year);
      else next.add(year);
      if (lastDrawn === year && !next.has(year)) setLastDrawn(null);
      persistUsed(next);
    },
    [usedYears, lastDrawn, persistUsed]
  );

  const clearUsedYears = useCallback(() => {
    setLastDrawn(null);
    persistUsed(new Set());
  }, [persistUsed]);

  const changeMode = useCallback(
    (m: GenMode) => {
      setMode(m);
      if (selected != null) select(selected, false, m);
    },
    [selected, select]
  );

  const changeGameVersion = useCallback(
    (v: GameVersion) => {
      setGameVersion(v);
      if (selected != null) select(selected, false, mode, undefined, undefined, v);
    },
    [selected, select, mode]
  );

  const pickGame = useCallback((v: GameVersion, remember: boolean) => {
    try { if (remember) localStorage.setItem(GAME_KEY, v); else localStorage.removeItem(GAME_KEY); } catch { /* private mode */ }
    setGameChosen(true);
    setGamePickerOpen(false);
    if (v !== gameVersion) changeGameVersion(v);
  }, [gameVersion, changeGameVersion]);

  const changeLeague = useCallback(
    (lg: string) => {
      setLeagueOverride(lg);
      if (selected != null) select(selected, false, mode, lg);
    },
    [selected, select, mode]
  );

  // Persist both edit maps under the loaded class's key and remember the previous
  // state for undo (Ctrl+Z / Ctrl+Shift+Z). Snapshots are small (sparse maps).
  const commitEdits = useCallback((nextEdits: ClassEdits, nextGear: GearEdits, record = true) => {
    const key = editKeyRef.current;
    if (record) {
      const h = historyRef.current;
      h.past = [...h.past.slice(-49), { edits: editsRef.current, gear: gearRef.current }];
      h.future = [];
    }
    editsRef.current = nextEdits;
    gearRef.current = nextGear;
    setEdits(nextEdits);
    setGearEdits(nextGear);
    if (key) {
      cache.editsSet(key.year, key.league, nextEdits);
      cache.gearEditsSet(key.year, key.league, nextGear);
    }
  }, []);

  const setEdit = useCallback(
    (id: number, fieldName: string, value: number | string) => {
      const prev = editsRef.current;
      commitEdits({ ...prev, [id]: { ...(prev[id] || {}), [fieldName]: value } }, gearRef.current);
    },
    [commitEdits]
  );


  const setGearEdit = useCallback(
    (id: number, slot: string, asset: string) => {
      const prev = gearRef.current;
      const player = { ...(prev[id] || {}) };
      if (asset) player[slot] = asset;
      else delete player[slot]; // empty = revert to era default
      const next = { ...prev, [id]: player };
      if (!Object.keys(player).length) delete next[id];
      commitEdits(editsRef.current, next);
    },
    [commitEdits]
  );

  const resetPlayer = useCallback(
    (id: number) => {
      const e = { ...editsRef.current };
      delete e[id];
      const g = { ...gearRef.current };
      delete g[id];
      commitEdits(e, g);
    },
    [commitEdits]
  );

  const undoEdit = useCallback(() => {
    const h = historyRef.current;
    const snap = h.past.pop();
    if (!snap) return;
    h.future.push({ edits: editsRef.current, gear: gearRef.current });
    commitEdits(snap.edits, snap.gear, false);
  }, [commitEdits]);

  const redoEdit = useCallback(() => {
    const h = historyRef.current;
    const snap = h.future.pop();
    if (!snap) return;
    h.past.push({ edits: editsRef.current, gear: gearRef.current });
    commitEdits(snap.edits, snap.gear, false);
  }, [commitEdits]);

  const clearAllEdits = useCallback(() => commitEdits({}, {}), [commitEdits]);

  /** Edits as a portable JSON document (validated on import against the class). */
  const exportEdits = useCallback(() => {
    if (!data) return null;
    const names: Record<number, string> = {};
    for (const r of data.rows) if (editsRef.current[r.id] || gearRef.current[r.id]) names[r.id] = `${r.firstName} ${r.lastName}`;
    return { format: 'draft-class-edits/1', year: data.year, league: data.league, gameVersion: data.gameVersion ?? 'm26', exportedAt: new Date().toISOString(), names, edits: editsRef.current, gearEdits: gearRef.current };
  }, [data]);

  const importEdits = useCallback((doc: { format?: string; year?: number; league?: string; edits?: ClassEdits; gearEdits?: GearEdits; names?: Record<number, string> }): string | null => {
    if (!data) return 'No class loaded';
    if (doc.format !== 'draft-class-edits/1') return 'Not an edits file';
    if (doc.year !== data.year || doc.league !== data.league) return `These edits are for ${doc.year} ${doc.league}, not ${data.year} ${data.league}`;
    // Names guard: a pick whose name changed (different cache version) is skipped.
    const byId = new Map(data.rows.map((r) => [r.id, `${r.firstName} ${r.lastName}`]));
    const edits: ClassEdits = {}, gear: GearEdits = {};
    let skipped = 0;
    for (const [idStr, patch] of Object.entries(doc.edits ?? {})) {
      const id = Number(idStr);
      if (doc.names?.[id] && byId.get(id) !== doc.names[id]) { skipped++; continue; }
      edits[id] = patch;
    }
    for (const [idStr, patch] of Object.entries(doc.gearEdits ?? {})) {
      const id = Number(idStr);
      if (doc.names?.[id] && byId.get(id) !== doc.names[id]) { skipped++; continue; }
      gear[id] = normalizeGearPatch(patch);
    }
    commitEdits({ ...editsRef.current, ...edits }, { ...gearRef.current, ...gear });
    return skipped ? `Imported; ${skipped} entries skipped (player names did not match)` : null;
  }, [data, commitEdits]);

  // One-time migration: All-Time edits used to be saved under the real-year key
  // shape (edits:0_NFL) while being loaded from edits:0_all-time, so they were lost.
  useEffect(() => {
    (async () => {
      const [oldE, newE] = await Promise.all([cache.editsGet(0, 'NFL'), cache.editsGet(0, 'all-time')]);
      if (Object.keys(oldE).length && !Object.keys(newE).length) { await cache.editsSet(0, 'all-time', oldE); await cache.editsDel(0, 'NFL'); }
      const [oldG, newG] = await Promise.all([cache.gearEditsGet(0, 'NFL'), cache.gearEditsGet(0, 'all-time')]);
      if (Object.keys(oldG).length && !Object.keys(newG).length) { await cache.gearEditsSet(0, 'all-time', oldG); await cache.gearEditsDel(0, 'NFL'); }
    })().catch(() => {});
  }, []);

  // Keyboard: Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z (or Ctrl+Y) redo, unless typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === 'z' && e.shiftKey) { e.preventDefault(); redoEdit(); }
      else if (e.key.toLowerCase() === 'z') { e.preventDefault(); undoEdit(); }
      else if (e.key.toLowerCase() === 'y') { e.preventDefault(); redoEdit(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undoEdit, redoEdit]);

  // Once the available years are known, load the saved range (or default to full span).
  useEffect(() => {
    if (!years.length) return;
    const lo = Math.min(...years);
    const hi = Math.max(...years);
    cache.rangeGet().then((r) => {
      if (r) setRange({ from: Math.max(lo, Math.min(hi, r.from)), to: Math.max(lo, Math.min(hi, r.to)) });
      else setRange({ from: lo, to: hi });
    });
  }, [years]);

  useEffect(() => { yearsRef.current = years; }, [years]);

  useEffect(() => {
    cache.cachedYears().then(setCachedYears);
    cache.usedYearsGet().then((a) => setUsedYears(new Set(a)));
    cache.recentYearsGet().then(setRecentYears);
    cache.customList().then(setCustomClasses);
    api.archetypesByPosition().then(setArchetypeOptions).catch(() => {});
    (async () => {
      // Deployment shape first, so a pinned per-game build never pulls its
      // first class for the wrong game.
      let pinned: GameVersion | null = null;
      try {
        const cfg = await api.appConfig();
        pinned = cfg.gameVersion;
        if (pinned) {
          setPinnedGame(pinned);
          setGameVersion(pinned);
          document.title = productTitle(pinned);
          document.querySelector('link[rel="icon"]')?.setAttribute('href', `/icons/${pinned}.png`);
        }
        setFranchiseEnabled(cfg.franchise);
        if (cfg.franchise) setView('home');
      } catch { /* older server: defaults stand */ }
      setCfgLoaded(true);
      // The fingerprint decides whether a cached class is still the one this
      // server would build. Read it before the first class, or a saved board
      // keeps the old Scout's read.
      try {
        const health = await fetch('/api/health', { cache: 'no-store' });
        if (health.ok) {
          const body = await health.json().catch(() => null);
          if (body?.generator) setGeneratorFingerprint(body.generator);
        }
      } catch { /* an offline cache is still better than an empty board */ }
      const ys = await api.years();
      setYears(ys);
      const def = ys.includes(2003) ? 2003 : ys[ys.length - 1];
      if (def) select(def, false, mode, undefined, undefined, pinned ?? gameVersion);
    })().catch((e) => setError(e.message));
    // Run once on mount; mode changes are handled via changeMode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-screen flex-col">
      <WhatsNew open={whatsNewOpen} onClose={closeWhatsNew} />
      <UpdateBanner />
      <MenuBar
        onCreateClass={() => openBuilder(null)}
        onOpenClass={() => setOpenerOpen(true)}
        onWhatsNew={openWhatsNew}
        view={view}
        onSetView={setView}
        franchiseEnabled={franchiseEnabled}
        gameVersion={gameVersion}
        onSetGameVersion={changeGameVersion}
        pinnedGame={pinnedGame}
        mode={mode}
        onSetMode={changeMode}
        version={appVersion}
        hasClass={!!data && view === 'draft'}
        exportActions={exportActionsRef}
        editTools={{ undo: undoEdit, redo: redoEdit, clearAll: clearAllEdits, exportEdits, importEdits }}
      />
      <TopBar
        view={view}
        onSetView={setView}
        onGoHome={() => setView('home')}
        onDrawRandom={drawRandomYear}
        canDraw={years.some((y) => !usedYears.has(y) && inRange(y))}
        mode={mode}
        onSetMode={changeMode}
        gameVersion={gameVersion}
        onSetGameVersion={changeGameVersion}
        pinnedGame={pinnedGame}
        onChangeGame={() => setGamePickerOpen(true)}
        franchiseEnabled={franchiseEnabled}
        showLeague={selected != null && isMergeEra(selected)}
        league={selected != null ? effLeague(selected) : 'NFL'}
        onSetLeague={changeLeague}
        connected={connected && !error}
        busy={busy}
        years={years}
        selected={selected}
        onSelectYear={(y) => {
          setFocusPlayer(null);
          const next = { ...draftOpts, source: 'year' as const };
          setDraftOpts(next);
          select(y, false, mode, undefined, next);
        }}
        onSelectPlayer={(y, name) => {
          setFocusPlayer(name);
          const next = { ...draftOpts, source: 'year' as const };
          setDraftOpts(next);
          select(y, false, mode, undefined, next);
        }}
        cachedYears={cachedYears}
        recentYears={recentYears}
      />
      <div className="flex min-h-0 flex-1">
        <SideRail view={view} onSetView={setView} franchiseEnabled={franchiseEnabled} />
        <main className="min-w-0 flex-1">
          {view === 'rosters' && <RostersView gameVersion={gameVersion} />}
          {view === 'home' && <HomePage onSelect={setView} onOpenOutliers={openOutliers} franchiseEnabled={franchiseEnabled} title={productTitle(pinnedGame ?? gameVersion)} />}
          {view === 'franchise' && franchiseEnabled && (
            <FranchiseView
              gameVersion={gameVersion}
              years={years}
              usedYears={usedYears}
              lastDrawn={lastDrawn}
              range={range}
              onDraw={drawRandomYear}
              onUndo={undoLastDraw}
              onSetRange={updateRange}
              onToggleUsed={toggleUsedYear}
              onClearUsed={clearUsedYears}
            />
          )}
          {view === 'draft' && (
            <>
          {error && (
            <div className="m-6 animate-rise rounded-xl border border-danger/40 bg-danger/10 px-5 py-4 text-sm text-red-200">
              <div className="flex items-center gap-2 font-semibold text-red-100">
                <Icon path={ICONS.warning} className="h-4 w-4" />
                Couldn’t load the draft class
              </div>
              <div className="mt-1 text-red-200/90">{error}</div>
              <div className="mt-2 text-xs text-red-300/70">
                Is the backend running on <code className="rounded bg-black/30 px-1">localhost:5174</code>? Start it with{' '}
                <code className="rounded bg-black/30 px-1">npm run dev</code> in <code className="rounded bg-black/30 px-1">server/</code>.
              </div>
            </div>
          )}
          {!data && !error && (busy ? <BoardSkeleton /> : <EmptyBoard />)}
          {data && (
            <ClassView
              data={data}
              source={source}
              busy={busy}
              onShowDropped={() => setShowDropped(true)}
              edits={edits}
              gearEdits={gearEdits}
              onEdit={setEdit}
              onGearEdit={setGearEdit}
              onResetPlayer={resetPlayer}
              editTools={{ undo: undoEdit, redo: redoEdit, clearAll: clearAllEdits, exportEdits, importEdits }}
              archetypeOptions={archetypeOptions}
              mode={mode}
              focusPlayer={focusPlayer}
              draftOpts={draftOpts}
              decades={[...new Set(years.map((y) => Math.floor(y / 10) * 10))].sort((a, b) => a - b)}
              onApplyDraftOpts={applyDraftOpts}
              customClasses={customClasses}
              onOpenBuilder={openBuilder}
              onRefresh={() => selected != null && select(selected, true)}
              exportActionsRef={exportActionsRef}
              onVariant={() => { if (selected == null) return; const next = { ...draftOpts, variant: (draftOpts.variant ?? 0) + 1 }; setDraftOpts(next); select(selected, true, mode, undefined, next); }}
              onResetVariant={() => { if (selected == null) return; const next = { ...draftOpts, variant: 0 }; setDraftOpts(next); select(selected, true, mode, undefined, next); }}
            />
          )}
            </>
          )}
        </main>
      </div>
      {showDropped && data && (
        <DroppedPanel data={data} included={draftOpts.include ?? []} onInclude={onInclude} onExclude={onExclude} onClose={() => setShowDropped(false)} busy={busy} />
      )}
      {builder.open && <ClassStudio initial={builder.initial} onClose={closeBuilder} onGenerate={generatePicked} />}
      {openerOpen && <OpenClass onOpened={openedClass} onClose={() => setOpenerOpen(false)} pinnedGame={pinnedGame} />}
      {!pinnedGame && cfgLoaded && (!gameChosen || gamePickerOpen) && (
        <GamePicker current={gameVersion} onPick={pickGame} onDismiss={gameChosen ? () => setGamePickerOpen(false) : undefined} />
      )}
    </div>
  );
}
