import { useEffect, useState } from 'react';
import type { DraftOpts } from '../App';
import { DEFAULT_DRAFT_OPTS } from '../App';
import type { CustomClass, TeamFranchise, FreakPreset } from '../types';
import { api } from '../api';

/** Draft-class generation controls: source (this year, greats, or a hand-picked
 *  class) plus modifiers (class strength, guaranteed studs, a generational #1).
 *  Applied on demand so slider drags don't trigger a regenerate per tick. */
export function DraftOptions({ opts, decades, busy, onApply, customClasses = [], onOpenBuilder }: {
  opts: DraftOpts;
  decades: number[];
  busy: boolean;
  onApply: (o: DraftOpts) => void;
  customClasses?: CustomClass[];
  onOpenBuilder?: (c: CustomClass | null) => void;
}) {
  const [source, setSource] = useState(opts.source);
  const [decade, setDecade] = useState(opts.decade);
  const [strength, setStrength] = useState(opts.strength);
  const [studs, setStuds] = useState(opts.studs);
  const [generational, setGenerational] = useState(opts.generational);
  const [hindsight, setHindsight] = useState(opts.hindsight ?? 1);
  const [autoStrength, setAutoStrength] = useState(!!opts.autoStrength);
  const [customId, setCustomId] = useState(opts.customId);
  const [fill, setFill] = useState(opts.fill !== false);
  const [team, setTeam] = useState(opts.team);
  const [franchises, setFranchises] = useState<TeamFranchise[]>([]);
  const [freakMode, setFreakMode] = useState(!!opts.freakMode || opts.source === 'freaks');
  const [freakPreset, setFreakPreset] = useState<FreakPreset>(opts.freakPreset ?? 'balanced');
  const [freakRate, setFreakRate] = useState(opts.freakRate ?? 0.04);
  const [freakSeed, setFreakSeed] = useState(opts.freakSeed ?? 2027);

  // The franchise list is fetched the first time "By team" is chosen.
  useEffect(() => {
    if (source !== 'team' || franchises.length) return;
    api.franchises().then(setFranchises).catch(() => {});
  }, [source, franchises.length]);

  useEffect(() => {
    setSource(opts.source); setDecade(opts.decade); setStrength(opts.strength); setStuds(opts.studs); setGenerational(opts.generational);
    setHindsight(opts.hindsight ?? 1); setAutoStrength(!!opts.autoStrength); setCustomId(opts.customId); setFill(opts.fill !== false); setTeam(opts.team);
    setFreakMode(!!opts.freakMode || opts.source === 'freaks'); setFreakPreset(opts.freakPreset ?? 'balanced');
    setFreakRate(opts.freakRate ?? (opts.freakPreset === 'all_freaks' ? 1.0 : opts.freakPreset === 'freak_show' ? 0.10 : opts.freakPreset === 'super_fusions' ? 0.08 : 0.04));
    setFreakSeed(opts.freakSeed ?? 2027);
  }, [opts]);

  const next: DraftOpts = {
    source, decade, strength, studs, generational, hindsight, autoStrength, variant: opts.variant ?? 0, customId, fill, team,
    freakMode: freakMode || source === 'freaks', freakPreset, freakRate, freakSeed,
  };
  const needsClass = (source === 'picked' && !customId) || (source === 'team' && !team);
  const teamInfo = franchises.find((f) => f.key === team);
  const hindsightLabel = hindsight <= 0.05 ? 'Draft day' : hindsight >= 0.95 ? 'Career outcome' : `${Math.round(hindsight * 100)}% outcome`;
  const dirty = JSON.stringify(next) !== JSON.stringify(opts);
  const strengthLabel = strength < 0.95 ? 'Weaker' : strength > 1.05 ? 'Stronger' : 'Normal';

  const seg = (active: boolean) =>
    `h-7 whitespace-nowrap rounded-md px-2.5 text-[11px] font-semibold transition-colors ${active ? 'bg-primary text-white shadow-sm' : 'text-neutral-400 hover:text-neutral-100'}`;

  return (
    <div className="glass rounded-xl px-4 py-3.5">
      <div className="flex flex-wrap items-start gap-x-7 gap-y-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Source</span>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex shrink-0 items-center rounded-lg border border-white/[0.06] bg-black/30 p-0.5">
              <button className={seg(source === 'year')} onClick={() => setSource('year')}>This year</button>
              <button className={seg(source === 'decade')} onClick={() => setSource('decade')}>By decade</button>
              <button className={seg(source === 'alltime')} onClick={() => setSource('alltime')}>All-Time</button>
              <button className={seg(source === 'team')} onClick={() => setSource('team')} title="The best players a franchise ever drafted, one class">By team</button>
              <button className={seg(source === 'freaks')} onClick={() => { setSource('freaks'); setFreakMode(true); }} title="Procedural draft class generated with unicorns & 3-way super-fusions">Freak Lab 🦄</button>
            </div>
            {source === 'team' && (
              <div className="flex items-center gap-2">
                {teamInfo?.logo && <img src={teamInfo.logo} alt="" className="h-6 w-6 object-contain" />}
                <select value={team ?? ''} onChange={(e) => setTeam(e.target.value || undefined)}
                  className="h-8 rounded-lg border border-white/[0.07] bg-black/30 px-2 text-xs text-neutral-200 focus:border-primary focus:outline-none">
                  <option value="">Choose a franchise…</option>
                  {franchises.map((f) => <option key={f.key} value={f.key}>{f.name}</option>)}
                </select>
              </div>
            )}
            {source === 'picked' && (
              <button onClick={() => onOpenBuilder?.(customClasses.find((c) => c.id === customId) ?? null)}
                className="h-8 rounded-lg border border-gold/50 bg-gold/10 px-2.5 text-xs font-medium text-gold hover:bg-gold/20">
                Open in Class Studio…
              </button>
            )}
            {source === 'decade' && (
              <select value={decade} onChange={(e) => setDecade(Number(e.target.value))}
                className="h-8 rounded-lg border border-white/[0.07] bg-black/30 px-2 text-xs tabular-nums text-neutral-200 focus:border-primary focus:outline-none">
                {decades.map((d) => <option key={d} value={d}>{d}s</option>)}
              </select>
            )}
          </div>
        </div>

        <div className="flex w-56 flex-col gap-1.5">
          <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Class strength <span className="normal-case tracking-normal text-neutral-300">· {autoStrength ? 'Auto' : strengthLabel}</span></span>
          <input type="range" min={0.7} max={1.3} step={0.05} value={strength} disabled={autoStrength} onChange={(e) => setStrength(Number(e.target.value))} className="mt-1.5 w-full disabled:opacity-40" />
          <label className="flex items-center gap-2 text-[11px] text-neutral-300" title="Scale the curve by how good the class really was (top-32 caliber vs the 1970-2015 norm): 1983 tops out higher than 2013">
            <input type="checkbox" checked={autoStrength} onChange={(e) => setAutoStrength(e.target.checked)} className="accent-primary" />
            Auto from the class's real strength
          </label>
        </div>

        <div className="flex w-56 flex-col gap-1.5" title="0 = the board scouts saw on draft day (the #1 pick leads, Brady is a 6th-rounder); 1 = how careers turned out. Dev traits always follow the outcome, so hidden gems keep their Superstar trait.">
          <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Hindsight <span className="normal-case tracking-normal text-neutral-300">· {hindsightLabel}</span></span>
          <input type="range" min={0} max={1} step={0.1} value={hindsight} onChange={(e) => setHindsight(Number(e.target.value))} className="mt-1.5 w-full" />
          <span className="flex justify-between text-[11px] text-muted"><span>Draft day</span><span>Career outcome</span></span>
        </div>

        {/* Freak Lab & Cholesky Variance Controls */}
        <div className="flex flex-col gap-1.5 rounded-lg border border-purple-500/20 bg-purple-950/20 p-2.5">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-purple-300">
              <span>🦄</span>
              <span>Outlier Engine {source === 'freaks' ? '(Active)' : 'Overlay'}</span>
            </span>
            {source !== 'freaks' && (
              <label className="flex items-center gap-1.5 text-[11px] font-medium text-purple-200 cursor-pointer">
                <input type="checkbox" checked={freakMode} onChange={(e) => setFreakMode(e.target.checked)} className="accent-purple-500" />
                Inject Outliers
              </label>
            )}
          </div>
          {(source === 'freaks' || freakMode) && (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <select
                value={freakPreset}
                onChange={(e) => {
                  const p = e.target.value as FreakPreset;
                  setFreakPreset(p);
                  setFreakRate(p === 'all_freaks' ? 1.0 : p === 'freak_show' ? 0.10 : p === 'super_fusions' ? 0.08 : 0.04);
                }}
                className="h-7 rounded border border-purple-500/30 bg-black/40 px-2 text-xs text-purple-100 focus:border-purple-400 focus:outline-none"
              >
                <option value="balanced">Balanced (4% Freaks · Realistic)</option>
                <option value="freak_show">Heavy Variance (10% Outliers)</option>
                <option value="super_fusions">Super-Fusions (8% · High Fusions)</option>
                <option value="all_freaks">All Outliers (100% Outliers)</option>
              </select>
              <button
                type="button"
                onClick={() => setFreakSeed((s) => (s + 7919) % 100000 + 1)}
                className="h-7 rounded border border-purple-500/30 bg-purple-500/20 px-2 text-[11px] font-medium text-purple-200 hover:bg-purple-500/30"
                title="Re-roll outlier RNG seed"
              >
                🎲 #{freakSeed}
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Guaranteed studs</span>
          <input type="number" min={0} max={20} value={studs} onChange={(e) => setStuds(Math.max(0, Math.min(20, Number(e.target.value))))}
            className="h-8 w-20 rounded-lg border border-white/[0.07] bg-black/30 px-2.5 text-xs tabular-nums text-neutral-200 focus:border-primary focus:outline-none" />
          <label className="flex items-center gap-2 text-[11px] text-neutral-300" title="Force the first pick to an X-Factor">
            <input type="checkbox" checked={generational} onChange={(e) => setGenerational(e.target.checked)} className="accent-primary" />
            Generational #1 (X-Factor)
          </label>
        </div>
      </div>

      <div className="mt-3.5 flex flex-wrap items-center gap-3 border-t border-white/[0.06] pt-3">
        <button onClick={() => onApply(next)} disabled={busy || !dirty || needsClass}
          className="press inline-flex h-8 items-center rounded-lg bg-primary px-4 text-xs font-bold text-white shadow-[0_2px_12px_rgba(47,107,255,0.35),inset_0_1px_0_rgba(255,255,255,0.18)] transition-all hover:bg-primary-light disabled:opacity-40">
          {busy ? 'Generating…' : 'Generate'}
        </button>
        {JSON.stringify(opts) !== JSON.stringify(DEFAULT_DRAFT_OPTS) && (
          <button onClick={() => onApply(DEFAULT_DRAFT_OPTS)} disabled={busy} className="text-xs text-muted hover:text-neutral-200">
            Reset to normal
          </button>
        )}
        <span className="text-[11px] text-muted">
          {source === 'alltime' ? 'Best players in history, one class'
            : source === 'file' ? 'Opened from a file; pick a source above to generate a class instead'
            : source === 'picked' ? 'Your Class Studio board, in pick order'
            : source === 'team' ? (teamInfo ? `The best players the ${teamInfo.name} ever drafted, every era` : 'Pick a franchise: its best draft picks ever, one class')
            : source === 'decade' ? `Greatest players drafted in the ${decade}s`
            : 'Modifiers apply to the selected year'}
        </span>
      </div>
    </div>
  );
}
