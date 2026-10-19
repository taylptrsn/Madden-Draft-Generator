import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import type { PlayerRow, GearOption, FrontSevenInfo } from '../types';
import { api, displayPortraitChain, type ArchetypeOption, type PersonaTrait, type PersonaFocusOption } from '../api';
import { POS_NAMES, DEV_NAMES, ATTR_GROUPS, humanize, fmtHeight, keyAttrsForPosition, tierColor } from '../constants';
import { RatingChip, DevBadge, Icon, ICONS, Pill, Button } from './ui';
import { RadarChart } from './RadarChart';
import { GearEditor, SLOT_LABELS } from './GearEditor';
import { AppearanceEditor } from './AppearanceEditor';
import type { FaceScan } from '../types';

/**
 * M27 Persona DNA editor: the generated (or edited) trait set as removable chips
 * plus an add picker. Writes a comma-separated id list into the player's edit
 * patch ('personaDNA'), which the export maps into the draft binary's 5 slots.
 */
/** Provenance of a real head, for the face card. */
function faceSourceLabel(src?: string | null): string {
  if (!src) return '';
  if (/bundle/.test(src)) return ' · scan in game files';
  if (/roster/.test(src)) return ' · on the game roster';
  if (src === 'legend-portrait') return ' · legend';
  if (/preset/.test(src)) return ' · preset only (check in-game)';
  return ' · carried over (unverified)';
}

const dnaIcon = (t: { name: string; icon?: string }) => t.icon ?? `/api/portrait/dna-icon/${encodeURIComponent(t.name)}`;
const humanTrait = (name: string) => name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^Contractminded$/, 'Contract-minded');
/** The game's display name when the API sent one, else the enum name spaced out. */
const traitLabel = (t: { name: string; label?: string }): string => t.label ?? humanTrait(t.name);

function TraitCard({ t, onRemove }: { t: PersonaTrait; onRemove?: () => void }) {
  return (
    <div className="relative flex flex-col items-center gap-1.5 rounded-lg border border-legend/30 bg-legend/10 px-2 pb-2 pt-3 text-center" title={t.description ?? traitLabel(t)}>
      {onRemove && (
        <button onClick={onRemove} aria-label={`Remove ${traitLabel(t)}`} title="Remove trait" className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full text-legend-light/70 transition-colors hover:bg-legend/30 hover:text-white">×</button>
      )}
      <img src={dnaIcon(t)} alt="" className="h-14 w-14 rounded-xl object-contain" loading="lazy" />
      <div className="text-[11px] font-semibold leading-tight text-legend-light">{traitLabel(t)}</div>
      {t.description && <div className="line-clamp-2 text-[11px] leading-snug text-neutral-400">{t.description}</div>}
    </div>
  );
}

/**
 * M27 Persona DNA section: the five slots as cards (icon, name, blurb) and a
 * browsable picker with every selectable trait and its picture. Writes a
 * comma-separated id list into the player's edit patch ('personaDNA'), which the
 * export maps into the draft binary's 5 slots.
 */
function PersonaSection({
  generated,
  generatedFocus,
  patch,
  onEdit,
}: {
  generated?: string[];
  generatedFocus?: string;
  patch: Record<string, number | string>;
  onEdit: (field: string, value: string) => void;
}) {
  const [traits, setTraits] = useState<PersonaTrait[]>([]);
  const [focusOptions, setFocusOptions] = useState<PersonaFocusOption[]>([]);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    api.personaLookups().then((r) => { setTraits(r.traits); setFocusOptions(r.focus); }).catch(() => {});
  }, []);

  // Mindset focus: one of four, its own field in the record (0xf2), separate from the trait slots.
  const focusEdited = patch.focus != null && patch.focus !== '';
  const generatedFocusId = focusOptions.find((f) => f.name === generatedFocus)?.id;
  const focusId = focusEdited ? Number(patch.focus) : generatedFocusId;

  const idOf = new Map(traits.map((t) => [t.name, t.id]));
  const byId = new Map(traits.map((t) => [t.id, t]));
  const edited = typeof patch.personaDNA === 'string';
  const generatedIds = (generated ?? []).map((n) => idOf.get(n)).filter((n): n is number => n != null);
  const ids: number[] = edited
    ? String(patch.personaDNA).split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0)
    : generatedIds;
  const apply = (next: number[]) => onEdit('personaDNA', next.join(','));
  const q = query.trim().toLowerCase();
  const pool = traits.filter((t) => !q || traitLabel(t).toLowerCase().includes(q) || (t.description ?? '').toLowerCase().includes(q));
  // Before the trait list loads, an unedited player still shows his generated names.
  const cards: (PersonaTrait | null)[] = traits.length || edited
    ? ids.map((id) => byId.get(id) ?? { id, name: `#${id}` })
    : (generated ?? []).map((n, i) => ({ id: -1 - i, name: n }));
  while (cards.length < 5) cards.push(null);

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-semibold tracking-wide text-muted">
          Mindset focus <span className="font-medium normal-case tracking-normal text-muted">· one of four · separate from the traits</span>
        </div>
        {focusEdited && generatedFocusId != null && (
          <button onClick={() => onEdit('focus', String(generatedFocusId))} title="Restore the generated focus" className="rounded-md px-2 py-1 text-[11px] text-muted underline-offset-2 transition-colors hover:text-neutral-200 hover:underline">
            Reset
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {(focusOptions.length ? focusOptions : generatedFocus ? [{ id: -1, name: generatedFocus, label: humanTrait(generatedFocus) }] : []).map((f) => {
          const on = f.id === focusId || (f.id === -1);
          return (
            <button
              key={f.name}
              onClick={() => { if (f.id >= 0) onEdit('focus', String(f.id)); }}
              aria-pressed={on}
              title={f.description ?? f.label}
              className={`flex min-h-[76px] flex-col items-start gap-1 rounded-lg border px-2.5 py-2 text-left transition-colors ${on ? 'border-legend/50 bg-legend/10' : 'border-border hover:border-legend/40 hover:bg-white/[0.06]'}`}
            >
              <span className={`text-[11px] font-semibold uppercase tracking-wide ${on ? 'text-legend-light' : 'text-neutral-200'}`}>{f.label}</span>
              {f.description && <span className="line-clamp-3 text-[11px] leading-snug text-neutral-400">{f.description}</span>}
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 border-t border-white/[0.05] pt-3">
        <div className="text-[11px] font-semibold tracking-wide text-muted">
          Persona DNA <span className="font-medium normal-case tracking-normal text-muted">· {ids.length}/5 slots · written into the M27 export</span>
        </div>
        <div className="flex items-center gap-2">
          {edited && generatedIds.length > 0 && (
            <button onClick={() => apply(generatedIds)} title="Restore the generated traits" className="rounded-md px-2 py-1 text-[11px] text-muted underline-offset-2 transition-colors hover:text-neutral-200 hover:underline">
              Reset
            </button>
          )}
          <button
            onClick={() => setAdding((v) => !v)}
            disabled={ids.length >= 5 && !adding}
            title={ids.length >= 5 ? 'All five slots are used — remove a trait to add another' : 'Browse every trait with its picture'}
            className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-xs font-medium text-neutral-200 transition-colors hover:border-white/[0.14] hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {adding ? 'Close' : '+ Add trait'}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5">
        {cards.map((t, i) => t ? (
          <TraitCard key={`${t.id}-${i}`} t={t} onRemove={traits.length ? () => apply(ids.filter((x) => x !== t.id)) : undefined} />
        ) : (
          <button
            key={`empty-${i}`}
            onClick={() => setAdding(true)}
            className="grid min-h-[104px] place-items-center rounded-lg border border-dashed border-border text-[11px] uppercase tracking-wider text-muted transition-colors hover:border-legend/40 hover:text-neutral-300"
          >
            empty slot
          </button>
        ))}
      </div>
      {adding && (
        <div className="rounded-lg border border-border-strong bg-surface-0 p-2.5" data-nested-editor>
          <div className="mb-2 flex items-center gap-2">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter traits…"
              className="w-56 rounded-md border border-border bg-surface-1 px-2 py-1 text-xs text-neutral-200 placeholder:text-muted focus:border-primary focus:outline-none"
            />
            <span className="text-[11px] text-muted">{ids.length >= 5 ? 'All five slots are used; remove one above to swap it.' : `Pick up to ${5 - ids.length} more. Dimmed traits are already on him.`}</span>
          </div>
          <div className="grid max-h-80 grid-cols-3 gap-1.5 overflow-auto pr-1 sm:grid-cols-4 md:grid-cols-6">
            {pool.map((t) => {
              const on = ids.includes(t.id);
              return (
                <button
                  key={t.id}
                  disabled={on || ids.length >= 5}
                  onClick={() => { const next = [...ids, t.id]; apply(next); if (next.length >= 5) setAdding(false); }}
                  title={t.description ?? traitLabel(t)}
                  className={`flex flex-col items-center gap-1 rounded-lg border p-1.5 text-center transition-colors ${on ? 'border-legend/40 bg-legend/10 opacity-50' : 'border-border hover:border-legend/40 hover:bg-white/[0.06]'} disabled:cursor-default`}
                >
                  <img src={dnaIcon(t)} alt="" className="h-12 w-12 rounded-xl object-contain" loading="lazy" />
                  <span className="text-[11px] font-medium leading-tight text-neutral-200">{traitLabel(t)}</span>
                  {t.description && <span className="line-clamp-2 text-[11px] leading-snug text-muted">{t.description}</span>}
                </button>
              );
            })}
            {pool.length === 0 && <div className="col-span-full py-4 text-center text-[11px] text-muted">No matching traits.</div>}
          </div>
        </div>
      )}
    </>
  );
}

/** Tooltip for the front-seven badge: how an LB-labeled player was placed (edge vs
 *  SAM/MIKE/WILL) and which signal decided it. */
function frontSevenTitle(f: FrontSevenInfo): string {
  const why: Record<string, string> = {
    sacks: 'career sack rate (>= 6 per starting season) marks an edge rusher',
    'sacks (no scheme)': 'high sack rate with few interceptions; drafting team scheme unknown',
    '3-4 olb': 'outside linebacker on a 3-4 team = edge rusher in Madden',
    '3-4 ilb': 'low sack rate on a 3-4 team = inside linebacker (MIKE)',
    '3-4 build': '3-4 team, no career stats; edge-sized build (low confidence)',
    '4-3 blitzer': 'moderate sack rate on a 4-3 team = blitzing strongside backer (SAM)',
    coverage: 'interception rate on a lighter frame = weakside coverage backer (WILL)',
    pff: 'PFF position data',
    nflverse: 'nflverse roster position',
  };
  const parts = [why[f.reason] ?? f.reason];
  if (f.scheme) parts.push(`drafting team (${f.team ?? '?'}) ran a ${f.scheme}`);
  if (f.sackRate != null) parts.push(`${f.sackRate} sacks per starting season`);
  return parts.join(' · ');
}

export function ProfileModal({
  row,
  patch,
  gearPatch,
  year,
  archetypeOptions,
  gameVersion = "m26",
  onEdit,
  onGearEdit,
  onReset,
  onClose,
  onNavigate,
  canPrev = false,
  canNext = false,
  spoilers = true,
  mode = 'draft',
  footer,
  variant = 'modal',
  onReveal,
}: {
  row: PlayerRow;
  patch: Record<string, number | string>;
  gearPatch: Record<string, string>;
  year: number;
  archetypeOptions: Record<string, ArchetypeOption[]>;
  gameVersion?: "m26" | "m27";
  onEdit: (field: string, value: number | string) => void;
  onGearEdit: (slot: string, asset: string) => void;
  onReset: () => void;
  onClose: () => void;
  onNavigate?: (delta: number) => void;
  /** false masks overall, dev trait, the radar and every rating (blind scouting). */
  spoilers?: boolean;
  canPrev?: boolean;
  canNext?: boolean;
  /** 'roster': a Rosters-view player. Always revealed; no draft slot, career value or combine; the
   *  arrows step through the roster list rather than the board. */
  mode?: 'draft' | 'roster';
  /** The line in the sticky footer; defaults to the draft editor's. */
  footer?: string;
  /** 'pane': docked beside the board (the scout desk) - no backdrop, no close, no focus grab. */
  variant?: 'modal' | 'pane';
  /** Flip Spoilers on from inside the editor (the blind-scouting strip's Reveal button). */
  onReveal?: () => void;
}) {
  const roster = mode === 'roster';
  const pane = variant === 'pane';
  if (roster) spoilers = true;
  // Avatar source chain (photo, then in-game portrait): imgErr counts how many
  // sources have failed so a dead photo URL falls back instead of going blank.
  const [imgErr, setImgErr] = useState(0);
  const imgChain = displayPortraitChain(row);
  const imgSrc = imgChain[imgErr] ?? null;
  const [gearOpts, setGearOpts] = useState<Record<string, GearOption[]>>({});
  const [gearOpen, setGearOpen] = useState(false);
  const [appearOpen, setAppearOpen] = useState(false);
  const [scans, setScans] = useState<FaceScan[]>([]);
  const [colleges, setColleges] = useState<{ id: number; name: string }[]>([]);
  const [heads, setHeads] = useState<Record<string, string[]>>({});
  const [faceTone, setFaceTone] = useState<number>(row.skinTone ?? 4);
  // Section jump-nav: the profile is a long scroll; these refs anchor each block.
  const scoutingRef = useRef<HTMLDivElement>(null);
  const ratingsRef = useRef<HTMLDivElement>(null);
  const bioRef = useRef<HTMLDivElement>(null);
  const appearRef = useRef<HTMLDivElement>(null);
  const equipRef = useRef<HTMLDivElement>(null);
  const personaRef = useRef<HTMLDivElement>(null);
  const attrsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api.equipmentOptions(year, gameVersion).then((o) => alive && setGearOpts(o)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [year, gameVersion]);

  useEffect(() => {
    let alive = true;
    api.lookup('college').then((o) => alive && setColleges(o)).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    api.genericHeads(gameVersion).then(setHeads).catch(() => {});
  }, [gameVersion]);
  useEffect(() => {
    let alive = true;
    api.faceScans(gameVersion).then((s) => alive && setScans(s)).catch(() => {});
    return () => { alive = false; };
  }, [gameVersion]);
  useEffect(() => setFaceTone(row.skinTone ?? 4), [row.id, row.skinTone]);
  useEffect(() => setImgErr(0), [row.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape closes the innermost layer only: a nested editor (equipment /
      // appearance / persona picker) handles its own Escape; the profile stays.
      if (e.key === 'Escape') {
        if (pane || gearOpen || appearOpen) return;
        if ((e.target as HTMLElement | null)?.closest?.('[data-nested-editor]')) return;
        onClose();
        return;
      }
      // <- / -> step through the board's players - but never while typing in a
      // field or while the equipment builder has focus.
      if (gearOpen || appearOpen || !onNavigate) return;
      const t = e.target as HTMLElement;
      if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
      if (e.key === 'ArrowLeft' && canPrev) { e.preventDefault(); onNavigate(-1); }
      else if (e.key === 'ArrowRight' && canNext) { e.preventDefault(); onNavigate(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onNavigate, canPrev, canNext, gearOpen, appearOpen, pane]);

  const eff = (field: string): number =>
    Number(field in patch ? patch[field] : field === 'overall' ? row.overall : (row.ratings[field] ?? 0));
  const effStr = (field: string, fallback: string): string =>
    typeof patch[field] === 'string' ? (patch[field] as string) : fallback;
  const effNum = (field: string, fallback: number): number =>
    field in patch ? Number(patch[field]) : fallback;
  const currentCollegeId =
    typeof patch.college === 'number' ? patch.college : colleges.find((c) => c.name === row.college)?.id ?? 0;


  const overall = Number(patch.overall ?? row.overall);
  const dev = Number(patch.devTrait ?? row.devTrait);
  const posId = Number(patch.position ?? row.positionId);
  const archetype = Number(patch.archetype ?? row.archetype);
  const posName = POS_NAMES[posId] ?? row.position;
  const edited = Object.keys(patch).length > 0;

  // "What the game will show": after any edit, ask the server for Madden's
  // recomputed overall (and, when overall/position/archetype changed, the
  // attributes the export re-solves) - debounced so slider drags don't spam it.
  const [gameView, setGameView] = useState<{ overall: number | null; archetype?: number; reconciled: Record<string, number> | null } | null>(null);
  useEffect(() => {
    if (!edited) { setGameView(null); return; }
    const ratings: Record<string, number> = {};
    for (const k of Object.keys(row.ratings)) ratings[k] = eff(k);
    const reconcile = 'overall' in patch || 'position' in patch || 'archetype' in patch;
    const t = setTimeout(() => {
      api.recompute({ gameVersion, positionId: posId, archetype, overall, ratings, reconcile })
        .then((r) => setGameView({ overall: r.gameOverall, archetype: r.gameArchetype, reconciled: r.reconciled }))
        .catch(() => setGameView(null));
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patch, row.id, posId, archetype, overall, gameVersion]);

  // Reset is destructive (clears rating + bio edits) — two-step inline confirm.
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => setConfirmReset(false), [row.id]);
  useEffect(() => {
    if (!confirmReset) return;
    const t = setTimeout(() => setConfirmReset(false), 4000);
    return () => clearTimeout(t);
  }, [confirmReset]);

  // Archetypes valid for the current position (+ the current one if it isn't listed).
  let archOpts = archetypeOptions[posName] ?? [];
  if (!archOpts.some((o) => o.id === archetype)) {
    archOpts = [{ id: archetype, name: row.archetypeName || `#${archetype}` }, ...archOpts];
  }
  const archName = archOpts.find((o) => o.id === archetype)?.name ?? row.archetypeName;

  const field = 'rounded-md border border-white/[0.07] bg-black/30 px-1.5 py-1 text-sm focus:border-primary focus:outline-none';
  // Face (generic head) picker: pool for the chosen skin tone; PEPS drives the write.
  const facePool = heads[String(faceTone)] ?? [];
  const curFace = effStr('genericHeadName', row.genericHead ?? '');
  const toneFromPhoto = (input: { imageUrl?: string; imageBase64?: string }) =>
    api.toneFromPhoto({ ...input, position: row.position, draftYear: row.draftYear, gameVersion });
  const faceIdx = facePool.indexOf(curFace);
  const pickFace = (i: number) => {
    if (!facePool.length) return;
    onEdit('genericHeadName', facePool[((i % facePool.length) + facePool.length) % facePool.length]);
  };
  const faceBtn = 'rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-xs text-neutral-200 transition-colors hover:bg-white/[0.07] disabled:opacity-40';
  const num = (key: string) => {
    const v = eff(key);
    if (!spoilers)
      return (
        <span
          className={`${field} inline-flex w-14 items-center justify-end font-semibold text-muted`}
          title="Hidden — tick Spoilers to reveal"
        >
          ?
        </span>
      );
    return (
      <input
        type="number"
        min={0}
        max={99}
        value={v}
        onChange={(e) => onEdit(key, Math.max(0, Math.min(99, parseInt(e.target.value || '0', 10))))}
        style={{ color: tierColor(v) }}
        className={`${field} w-14 text-right font-semibold tabular-nums`}
      />
    );
  };

  const content = (
    <>
    <div className={pane ? 'flex h-full min-h-0 w-full' : 'fixed inset-0 z-40 flex animate-fade-in justify-end bg-black/55'} onClick={pane ? undefined : onClose}>
      <div
        role={pane ? 'region' : 'dialog'}
        aria-modal={pane ? undefined : true}
        aria-label={`${row.firstName} ${row.lastName} profile`}
        tabIndex={-1}
        ref={(el) => { if (!pane && el && !el.contains(document.activeElement)) el.focus({ preventScroll: true }); }}
        className={pane ? 'flex h-full w-full animate-fade-in flex-col overflow-auto outline-none' : 'flex h-full w-[520px] max-w-full animate-slide-in-right flex-col overflow-auto border-l border-white/[0.07] bg-surface-1 shadow-[-12px_0_36px_rgba(0,0,0,0.45)] outline-none'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 border-b border-white/[0.06] bg-surface-1">
          <div className="relative flex items-start gap-3 px-4 pt-3"><span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-primary/[0.07] to-transparent" />
          <div className="relative flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/[0.08] bg-surface-2 shadow-[0_6px_18px_rgba(0,0,0,0.4)]">
            {imgSrc ? (
              <img
                key={imgSrc}
                src={imgSrc}
                alt=""
                className="h-full w-full object-cover"
                onError={() => setImgErr((e) => e + 1)}
              />
            ) : (
              <span className="text-2xl font-bold text-neutral-600">
                {(row.firstName[0] || '') + (row.lastName[0] || '')}
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1 pr-20">
            <div className="relative font-display text-lg font-bold leading-tight">
              {effStr('firstName', row.firstName)} {effStr('lastName', row.lastName)}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-xs font-semibold text-neutral-300 ring-1 ring-white/[0.06]">{posName}</span>
              <RatingChip ovr={gameView?.overall ?? overall} size="sm" hidden={!spoilers} />
              {gameView && gameView.archetype != null && gameView.archetype !== archetype && (
                <span
                  className="rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[11px] text-warning"
                  title="Madden labels a prospect with whichever of its archetypes scores his attributes highest."
                >
                  as {archOpts.find((o) => o.id === gameView.archetype)?.name ?? `#${gameView.archetype}`}
                </span>
              )}
              <DevBadge dev={dev} hidden={!spoilers} />
              {row.twoWay && row.twoWay.roles.length > 0 && (
                <span
                  title={row.twoWay.source === 'era'
                    ? `Single-platoon era (through 1949): every player went both ways, so his ${row.twoWay.roles.join(' / ')} ratings are floored a step below his overall.`
                    : `${row.twoWay.note ?? 'Two-way player'} — the ${row.twoWay.roles.join(' / ')} ratings are floored near his overall so the depth chart can play him there.`}
                  className="rounded border border-legend/40 bg-legend/10 px-1.5 py-0.5 text-[11px] text-legend-light"
                >
                  also {row.twoWay.roles.join(' · ')}
                </span>
              )}
              {row.supplemental && (
                <span
                  title={`Selected in the ${row.draftYear} NFL supplemental draft, round ${row.supplemental.round}${row.supplemental.team ? ` by the ${row.supplemental.team.name}` : ''}. A supplemental pick has no overall pick number; the club gave up that round's pick the next year. He is placed after the round's regular picks.`}
                  className="rounded border border-legend/40 bg-legend/10 px-1.5 py-0.5 text-[11px] text-legend-light"
                >
                  Supplemental
                </span>
              )}
              {row.frontSeven && row.frontSeven.role && (
                <span
                  title={frontSevenTitle(row.frontSeven)}
                  className="rounded border border-border px-1.5 py-0.5 text-[11px] uppercase tracking-wider text-neutral-400"
                >
                  {row.frontSeven.role === 'EDGE' ? 'edge' : 'off-ball'} · {row.frontSeven.reason}
                </span>
              )}
            </div>
            <div className="mt-1.5 text-xs text-muted">
              {archName ? <span className="text-neutral-300">{archName} · </span> : null}{row.college || '—'} · {fmtHeight(row.heightInches)} · {row.weight || '—'} lb · age {row.age || '—'}
              {roster ? '' : row.supplemental ? ` · Supplemental Rd ${row.supplemental.round}` : row.round ? ` · Rd ${row.round}` : ''} {!roster && row.wav != null ? `· wAV ${row.wav}` : ''}
            </div>
          </div>
          {onNavigate && (
            <div className="absolute right-12 top-3 flex items-center gap-0.5">
              <button
                onClick={() => onNavigate(-1)}
                disabled={!canPrev}
                title={roster ? 'Previous player (←)' : 'Previous player on the board (←)'}
                aria-label="Previous player"
                className="rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-white/[0.06] hover:text-neutral-100 disabled:opacity-30"
              >
                <Icon path={ICONS.chevronDown} className="h-4 w-4 rotate-90" />
              </button>
              <button
                onClick={() => onNavigate(1)}
                disabled={!canNext}
                title={roster ? 'Next player (→)' : 'Next player on the board (→)'}
                aria-label="Next player"
                className="rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-white/[0.06] hover:text-neutral-100 disabled:opacity-30"
              >
                <Icon path={ICONS.chevronDown} className="h-4 w-4 -rotate-90" />
              </button>
            </div>
          )}
          {!pane && (
          <button
            onClick={onClose}
            className="absolute right-4 top-3 rounded-md p-1 text-muted transition-colors hover:bg-white/[0.06] hover:text-neutral-200"
            aria-label="Close"
          >
            <Icon path={ICONS.close} className="h-5 w-5" />
          </button>
          )}
          </div>
          {/* Section jump-nav — the profile is a long scroll. */}
          <div className="flex flex-wrap items-center gap-0.5 px-5 pb-2 pt-1">
            {(
              [
                ...(roster ? [] : ([['Scouting', scoutingRef]] as const)),
                ['Ratings', ratingsRef],
                ['Bio', bioRef],
                ['Appearance', appearRef],
                ['Equipment', equipRef],
                ...(row.persona ? ([['Persona', personaRef]] as const) : []),
                ['Attributes', attrsRef],
              ] as const
            ).map(([label, ref]) => (
              <button
                key={label}
                onClick={() => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                className="rounded-md px-2 py-1 text-[11px] font-semibold text-neutral-400 transition-colors hover:bg-white/[0.06] hover:text-neutral-100"
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div ref={scoutingRef} className="scroll-mt-36 border-b border-white/[0.06] px-5 py-4">
          {spoilers ? (
            <>
              <RadarChart
                data={keyAttrsForPosition(posId).map(([k, label]) => ({ label, value: eff(k) }))}
                color={tierColor(gameView?.overall ?? overall)}
              />
              <p className="mt-1 text-center text-[11px] text-muted">
                Signature {posName} attributes — dashed gold ring = elite (90+)
              </p>
            </>
          ) : (
            // The chart's outline is the ratings, so plotting it would leak them.
            <div className="flex h-[72px] items-center justify-between gap-3 rounded-lg border border-dashed border-white/15 bg-white/[0.02] px-4">
              <span className="flex items-center gap-2.5 text-xs text-muted">
                <Icon path={ICONS.eyeOff} className="h-4 w-4 shrink-0" />
                <span>Signature {posName} ratings are hidden while you scout blind.</span>
              </span>
              {onReveal && (
                <Button size="xs" onClick={onReveal} title="Turn Spoilers on for the whole board">
                  <Icon path={ICONS.eye} className="h-3.5 w-3.5" /> Reveal
                </Button>
              )}
            </div>
          )}

          {row.freak && row.freak.isFreak && (
            <div className="mb-4 rounded-xl border border-purple-500/30 bg-purple-950/25 p-3.5 shadow-sm ring-1 ring-purple-500/20">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-sm font-bold text-purple-200">
                  <span className="text-lg">{row.freak.emoji}</span>
                  <span>{row.freak.archetypeLabel}</span>
                </span>
                <span className="rounded-md border border-purple-400/40 bg-purple-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-purple-200">
                  {row.freak.tier}
                </span>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-purple-100/90">{row.freak.summary}</p>
              {row.freak.historicalComps && row.freak.historicalComps.length > 0 && (
                <div className="mt-2.5 border-t border-purple-500/20 pt-2 text-[11px] text-purple-200/80">
                  <span className="font-semibold text-purple-300">1936–2026 Historical Comps: </span>
                  <span>{row.freak.historicalComps.join(' · ')}</span>
                </div>
              )}
            </div>
          )}

          {row.scouting && row.scouting.length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">Scout's read</div>
              <ul className="space-y-1 text-[13px] leading-snug text-neutral-200">
                {row.scouting.map((line, i) => (
                  <li key={i} className="flex gap-2">
                    <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-neutral-500" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {row.combine &&
          (() => {
            const c = row.combine;
            const metrics: [string, number | null, string][] = [
              ['40 yd', c.forty, 's'],
              ['Bench', c.bench, ''],
              ['Vert', c.vertical, '"'],
              ['Broad', c.broad, '"'],
              ['3-Cone', c.cone, 's'],
              ['Shuttle', c.shuttle, 's'],
            ];
            return (
              <div className="border-b border-white/[0.06] px-5 py-3">
                <div className="mb-2 text-[11px] font-semibold tracking-wide text-muted">
                  NFL Combine <span className="text-muted">· drives speed / strength / jump / agility</span>
                </div>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                  {metrics.map(([label, val, unit]) => (
                    <div key={label} className="rounded-lg bg-white/[0.04] px-1.5 py-1.5 text-center ring-1 ring-white/[0.05]">
                      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
                      <div className="text-sm font-semibold tabular-nums text-neutral-100">
                        {val != null ? `${val}${unit}` : '—'}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

        <div ref={ratingsRef} className="space-y-3 scroll-mt-36 border-b border-white/[0.06] px-5 py-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-neutral-400">
              Position
              <select
                value={posId}
                onChange={(e) => onEdit('position', parseInt(e.target.value, 10))}
                className={`${field} mt-1 block w-full`}
              >
                {POS_NAMES.map((n, i) => (
                  <option key={i} value={i}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-neutral-400">
              Dev Trait
              <select
                value={dev}
                onChange={(e) => onEdit('devTrait', parseInt(e.target.value, 10))}
                className={`${field} mt-1 block w-full`}
              >
                {DEV_NAMES.map((n, i) => (
                  <option key={i} value={i}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-neutral-400">
              Jersey #
              <input
                type="number"
                min={0}
                max={99}
                value={patch.jerseyNum ?? row.jersey}
                onChange={(e) => onEdit('jerseyNum', Math.max(0, Math.min(99, parseInt(e.target.value || '0', 10))))}
                className={`${field} mt-1 block w-full tabular-nums`}
              />
            </label>
          </div>
          <label className="block text-xs text-neutral-400">
            Archetype
            <select
              value={archetype}
              onChange={(e) => onEdit('archetype', parseInt(e.target.value, 10))}
              className={`${field} mt-1 block w-full`}
            >
              {archOpts.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div ref={bioRef} className="space-y-3 scroll-mt-36 border-b border-white/[0.06] px-5 py-4">
          <div className="text-[11px] font-semibold tracking-wide text-muted">Bio</div>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-neutral-400">
              First name
              <input
                type="text"
                maxLength={16}
                value={effStr('firstName', row.firstName)}
                onChange={(e) => onEdit('firstName', e.target.value)}
                className={`${field} mt-1 block w-full`}
              />
            </label>
            <label className="text-xs text-neutral-400">
              Last name
              <input
                type="text"
                maxLength={20}
                value={effStr('lastName', row.lastName)}
                onChange={(e) => onEdit('lastName', e.target.value)}
                className={`${field} mt-1 block w-full`}
              />
            </label>
          </div>
          <label className="block text-xs text-neutral-400">
            College <span className="text-muted">(only Madden‑recognized schools)</span>
            <select
              value={currentCollegeId}
              onChange={(e) => onEdit('college', parseInt(e.target.value, 10))}
              className={`${field} mt-1 block w-full`}
            >
              {colleges.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-3 gap-3">
            <label className="text-xs text-neutral-400">
              Height (in)
              <input
                type="number"
                min={60}
                max={84}
                value={effNum('heightInches', row.heightInches ?? 72)}
                onChange={(e) => onEdit('heightInches', Math.max(60, Math.min(84, parseInt(e.target.value || '72', 10))))}
                className={`${field} mt-1 block w-full tabular-nums`}
              />
            </label>
            <label className="text-xs text-neutral-400">
              Weight (lb)
              <input
                type="number"
                min={140}
                max={400}
                value={effNum('weight', row.weight ?? 200)}
                onChange={(e) => onEdit('weight', Math.max(140, Math.min(400, parseInt(e.target.value || '200', 10))))}
                className={`${field} mt-1 block w-full tabular-nums`}
              />
            </label>
            <label className="text-xs text-neutral-400">
              Age
              <input
                type="number"
                min={18}
                max={45}
                value={effNum('age', row.age ?? 22)}
                onChange={(e) => onEdit('age', Math.max(18, Math.min(45, parseInt(e.target.value || '22', 10))))}
                className={`${field} mt-1 block w-full tabular-nums`}
              />
            </label>
          </div>
        </div>

          <div ref={appearRef} className="space-y-2.5 scroll-mt-36 border-b border-white/[0.06] px-5 py-4">
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-semibold tracking-wide text-muted">
              Appearance <span className="font-medium normal-case tracking-normal text-muted">· {gameVersion === 'm27' ? 'M27' : 'M26'} scans</span>
            </div>
            <span className="inline-flex items-center gap-2">
            {row.face !== 'asset' && (row.toneSource === 'prior' || row.toneSource === 'csv') ? (
              <span title="No photo evidence for his skin tone: it comes from the position/era prior. Open the editor to check it against a photo."><Pill tone="neutral">Unverified tone</Pill></span>
            ) : null}
            <button
              onClick={() => setAppearOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-xs font-medium text-neutral-200 transition-colors hover:border-white/[0.14] hover:bg-white/[0.06]"
            >
              <Icon path={ICONS.image} className="h-3.5 w-3.5" /> Edit appearance
            </button>
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-surface-2">
              {curFace && /^gen_/i.test(curFace) ? (
                <img key={curFace} src={`/api/portrait/generic-head/${encodeURIComponent(curFace)}`} alt="" className="h-full w-full object-cover" />
              ) : imgSrc ? (
                <img key={imgSrc} src={imgSrc} alt="" className="h-full w-full object-cover" onError={() => setImgErr((e) => e + 1)} />
              ) : (
                <Icon path={ICONS.image} className="h-6 w-6 text-neutral-600" />
              )}
            </span>
            <div className="min-w-0 text-[11px] leading-relaxed text-neutral-400">
              <div className="truncate text-neutral-200">
                {typeof patch.faceAsset === 'string' && patch.faceAsset
                  ? `Scan ${patch.faceAsset}`
                  : curFace
                    ? curFace
                    : row.face === 'asset'
                      ? `Real face asset${faceSourceLabel(row.faceSource)}`
                      : 'Generated generic'}
              </div>
              <div>Tone {faceTone} · {effStr('bodyType', row.bodyType || 'Standard')}</div>
            </div>
          </div>
        </div>

        <div ref={equipRef} className="space-y-2.5 scroll-mt-36 border-b border-white/[0.06] px-5 py-4">
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-semibold tracking-wide text-muted">Equipment</div>
            <button
              onClick={() => setGearOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-xs font-medium text-neutral-200 transition-colors hover:border-white/[0.14] hover:bg-white/[0.06]"
            >
              <Icon path={ICONS.image} className="h-3.5 w-3.5" /> Edit equipment
            </button>
          </div>
          {Object.keys(gearPatch).length ? (
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(gearPatch).map(([slot, val]) => {
                const opt = (gearOpts[slot] ?? []).find((o) => o.value === val);
                return (
                  <span key={slot} className="inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1 text-[11px] text-neutral-300 ring-1 ring-border-strong">
                    {opt?.image && <img src={opt.image} alt="" className="h-4 w-4 object-contain" />}
                    <span className="text-muted">
                      {SLOT_LABELS[slot] ?? slot.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}:
                    </span>{' '}
                    {opt?.label ?? val}
                  </span>
                );
              })}
            </div>
          ) : (
            <p className="text-[11px] text-muted">Auto — era-appropriate gear ({year}). Click “Edit equipment” to customize.</p>
          )}
        </div>

        {row.persona && (
          <div ref={personaRef} className="space-y-2.5 scroll-mt-36 border-b border-white/[0.06] px-5 py-4">
            <PersonaSection generated={row.persona} generatedFocus={row.focus} patch={patch} onEdit={onEdit} />
          </div>
        )}

        <div ref={attrsRef} className="space-y-5 scroll-mt-36 px-5 py-4">
          {ATTR_GROUPS.map((g) => (
            <div key={g.title}>
              <div className="mb-2 text-[11px] font-semibold tracking-wide text-muted">{g.title}</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                {g.keys.map((k) => (
                  <div key={k} className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs text-neutral-400">{humanize(k)}</span>
                    {num(k)}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="sticky bottom-0 mt-auto flex items-center justify-between gap-2 border-t border-white/[0.06] bg-surface-1 px-4 py-2.5">
          <span className="text-[11px] text-muted">{footer ?? 'Edits save automatically & apply to the .mdc export.'}</span>
          <button
            onClick={() => {
              if (confirmReset) {
                onReset();
                setConfirmReset(false);
              } else {
                setConfirmReset(true);
              }
            }}
            disabled={!edited}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40 ${
              confirmReset
                ? 'border-danger/60 bg-danger/15 text-red-200 hover:bg-danger/25'
                : 'border-border-strong text-neutral-300 hover:bg-white/[0.06]'
            }`}
          >
            {confirmReset ? 'Confirm reset?' : 'Reset player'}
          </button>
        </div>
      </div>
    </div>
    {appearOpen && (
      <AppearanceEditor
        playerName={`${row.firstName} ${row.lastName}`}
        gameVersion={gameVersion}
        heads={heads}
        scans={scans}
        currentHead={curFace}
        currentAsset={typeof patch.faceAsset === 'string' ? patch.faceAsset : (row.face === 'asset' && row.genericHead == null ? '' : '')}
        currentTone={faceTone}
        currentBody={effStr('bodyType', row.bodyType || 'Standard')}
        generatedHead={row.genericHead ?? ''}
        generatedTone={row.skinTone ?? 4}
        generatedBody={row.bodyType || 'Standard'}
        isRealFace={row.face === 'asset'}
        referencePhotos={imgChain.filter((u) => u !== row.portrait)}
        onToneFromPhoto={toneFromPhoto}
        onEdit={onEdit}
        onClose={() => setAppearOpen(false)}
      />
    )}
    {gearOpen && (
      <GearEditor
        playerName={`${row.firstName} ${row.lastName}`}
        options={gearOpts}
        gearPatch={gearPatch}
        onGearEdit={onGearEdit}
        onClose={() => setGearOpen(false)}
        gameVersion={gameVersion}
        year={year}
        positionId={row.positionId}
        autoGear={row.gear ?? {}}
      />
    )}
    </>
  );
  // Fullscreen overlays must escape animated/contained board ancestors.
  // The scout desk remains in its grid; its nested editors portal separately.
  return pane ? content : createPortal(content, document.body);
}
