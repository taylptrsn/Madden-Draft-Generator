import { displayPortrait } from '../api';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { PlayerRow } from '../types';
import { ATTR_COLUMNS, groupForId, keyAttrsForPosition, tierColor } from '../constants';
import type { ColumnPreset } from './Toolbar';
import { RatingChip, DevBadge, TeamLogo, Portrait } from './ui';

type Row = PlayerRow & { edited?: boolean };
type AttrCol = (typeof ATTR_COLUMNS)[number];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export { ATTR_COLUMNS };

/** Columns the spoiler mask hides. Sorting by any of them would order the board
 *  by the very numbers being hidden, so they stop being sortable while masked --
 *  hiding a value but ranking by it is not hiding it. */
export const SPOILER_SORTS = new Set<string>(['ovr', 'dev', 'wav', ...ATTR_COLUMNS.map((c) => c.id)]);

const ROW_H = 40;
const OVERSCAN = 8;
const BY_KEY: Record<string, AttrCol> = Object.fromEntries(ATTR_COLUMNS.map((c) => [c.key, c]));

/** Which attribute columns a preset shows. 'position' follows the position
 *  filter; with no filter it shows a per-row Signature column instead. */
function columnsFor(preset: ColumnPreset, pos: string, rows: Row[]): { cols: AttrCol[]; signature: boolean } {
  if (preset === 'all') return { cols: [...ATTR_COLUMNS], signature: false };
  if (preset === 'physical') return { cols: ATTR_COLUMNS.slice(0, 10), signature: false };
  if (preset === 'position') {
    // An exact position label or a group code both resolve to one group; if the
    // visible rows all share a group (a filtered board), use that group too.
    const groups = new Set(rows.map((r) => groupForId(r.positionId)));
    const one = pos !== 'ALL' ? (rows[0] ? groupForId(rows[0].positionId) : null) : groups.size === 1 ? [...groups][0] : null;
    if (one && rows[0]) {
      const cols = keyAttrsForPosition(rows[0].positionId).map(([k]) => BY_KEY[k]).filter(Boolean);
      return { cols, signature: false };
    }
    return { cols: [], signature: true };
  }
  return { cols: [], signature: false };
}

/** Same thresholds the rating chips use, so a 90 reads as elite everywhere. */
function attrTone(v: number): string {
  if (v >= 90) return 'text-gold';
  if (v >= 80) return 'text-success-light';
  if (v >= 70) return 'text-neutral-200';
  return 'text-neutral-500';
}

function wavTag(source: string): { label: string; cls: string; title: string } {
  if (source === 'actual') return { label: 'A', cls: 'text-info', title: 'actual career wAV' };
  if (source === 'preset')
    return { label: 'EA', cls: 'text-gold', title: "EA's official rookie rating — no career wAV yet" };
  if (source === 'launch')
    return { label: 'EA', cls: 'text-gold', title: "EA's launch-day rating for this rookie (overall and attributes as shipped)" };
  return { label: 'P', cls: 'text-muted', title: 'predicted from draft slot / era' };
}

/** The round a pick belongs to on the board (supplemental picks sit in their own round). */
export const roundOf = (r: PlayerRow): number | null => r.supplemental?.round ?? r.round ?? null;

function SortTh({
  id,
  sort,
  onSort,
  className,
  children,
  locked = false,
}: {
  id: string;
  sort?: string;
  onSort?: (s: string) => void;
  className: string;
  children: ReactNode;
  locked?: boolean;
}) {
  if (locked)
    return (
      <th className={`${className} font-semibold text-neutral-600`} title="Hidden while Spoilers is off">
        {children}
      </th>
    );
  if (!onSort) return <th className={`${className} font-semibold`}>{children}</th>;
  const col = (sort ?? '').replace(/^-/, '');
  const on = col === id;
  const desc = on && (sort ?? '').startsWith('-');
  return (
    <th className={className} aria-sort={on ? (desc ? 'descending' : 'ascending') : 'none'}>
      <button
        onClick={() => {
          if (!on) onSort(id === 'ovr' || id === 'wav' || id === 'dev' ? `-${id}` : id);
          else onSort(desc ? id : `-${id}`);
        }}
        title={on ? `Sorted ${desc ? 'high → low' : 'low → high'} — click to flip` : `Sort by ${id}`}
        className={`inline-flex items-center gap-1 font-semibold uppercase tracking-wide transition-colors ${
          on ? 'text-primary-light' : 'text-neutral-500 hover:text-neutral-200'
        }`}
      >
        {children}
        {on && (
          <span aria-hidden className="text-[11px]">
            {desc ? '▼' : '▲'}
          </span>
        )}
      </button>
    </th>
  );
}

/* ------------------------------------------------------------------ */
/*  One row. Memoised: a 400-row board re-renders only the rows whose  */
/*  own props changed (selection, highlight, spoilers).                 */
/* ------------------------------------------------------------------ */
const BoardRow = memo(function BoardRow({
  r,
  active,
  highlighted,
  focused,
  spoilers,
  reveal,
  cols,
  signature,
  ticker,
  maxWav,
  onActivate,
  onFocusRow,
  onKey,
  setRef,
}: {
  r: Row;
  active: boolean;
  highlighted: boolean;
  focused: boolean;
  spoilers: boolean;
  reveal: boolean;
  cols: AttrCol[];
  signature: boolean;
  ticker: boolean;
  maxWav: number;
  onActivate: (id: number) => void;
  onFocusRow: (id: number) => void;
  onKey: (e: KeyboardEvent<HTMLTableRowElement>, id: number) => void;
  setRef: (id: number, el: HTMLTableRowElement | null) => void;
}) {
  const tag = wavTag(r.wavSource);
  const wavPct = r.wav != null ? Math.max(2, (r.wav / maxWav) * 100) : 0;
  return (
    <tr
      ref={(el) => setRef(r.id, el)}
      tabIndex={highlighted ? 0 : -1}
      aria-selected={active}
      onFocus={() => onFocusRow(r.id)}
      onKeyDown={(e) => onKey(e, r.id)}
      onClick={() => onActivate(r.id)}
      style={{ height: ROW_H }}
      className={`board-row group cursor-pointer border-t border-white/[0.04] outline-none transition-colors focus-visible:bg-white/[0.04] ${
        focused
          ? 'bg-gold/15 hover:bg-gold/20'
          : active
            ? 'bg-primary/12 hover:bg-primary/15'
            : 'hover:bg-white/[0.035]'
      }`}
    >
      {/* Tier stripe: the eye finds the 80+ players before it reads a number. */}
      <td className="w-[3px] p-0">
        <i className="block h-10 w-[3px] transition-colors duration-300" style={{ background: spoilers ? tierColor(r.overall) : 'transparent' }} />
      </td>
      <td className={`pr-2 text-right tabular-nums ${ticker ? 'pl-2 font-display text-[13px] font-bold text-neutral-400' : 'pl-3 text-[11px] font-medium text-neutral-500'}`}>
        {r.supplemental ? 'S' : r.pick}
      </td>
      <td className="px-2">
        <span className="flex items-center justify-center">
          <TeamLogo team={r.team} size="md" />
        </span>
      </td>
      <td className="px-3 font-medium text-neutral-100">
        <span className="inline-flex items-center gap-2.5">
          <Portrait src={displayPortrait(r)} fallback={r.portrait} size="xs" />
          <span className="inline-flex items-center gap-1.5">
            {r.edited && <span className="h-1.5 w-1.5 rounded-full bg-gold shadow-[0_0_6px_rgba(245,197,24,0.8)]" title="edited" />}
            <span className="truncate">{r.firstName} {r.lastName}</span>
            {r.supplemental && <span className="rounded border border-legend/40 px-1 text-[11px] uppercase tracking-wider text-legend-light" title={`Supplemental draft pick, round ${r.supplemental.round}`}>S</span>}
            {spoilers && r.freak?.isFreak && (
              <span className="inline-flex items-center gap-1 rounded border border-purple-500/40 bg-purple-500/15 px-1.5 py-0.2 text-[10px] font-semibold text-purple-200" title={`${r.freak.archetypeLabel} (${r.freak.tier.toUpperCase()}): ${r.freak.summary}`}>
                <span>{r.freak.emoji}</span>
                <span className="hidden xl:inline">{r.freak.archetypeLabel}</span>
              </span>
            )}
          </span>
        </span>
      </td>
      <td className="px-3">
        <span className="inline-flex h-5 items-center rounded bg-white/[0.05] px-1.5 text-[11px] font-semibold text-neutral-300 ring-1 ring-white/[0.06]">
          {r.position}
        </span>
      </td>
      <td className="px-3 text-center">
        <RatingChip ovr={r.overall} size="sm" hidden={!spoilers} animate={reveal && spoilers} />
      </td>
      <td className="px-2">
        <span className="flex justify-center"><DevBadge dev={r.devTrait} hidden={!spoilers} /></span>
      </td>
      <td className="px-3">
        <div className="flex items-center justify-end gap-2">
          <span className="h-1 w-16 overflow-hidden rounded-full bg-white/[0.06]">
            {spoilers && (
              <span
                className="block h-full rounded-full bg-gradient-to-r from-primary to-primary-light transition-[width] duration-500"
                style={{ width: `${wavPct}%`, transitionTimingFunction: 'var(--ease-out-expo)' }}
              />
            )}
          </span>
          <span className="w-8 text-right text-xs tabular-nums text-neutral-300">{spoilers ? (r.wav ?? '—') : '?'}</span>
          <span className={`w-5 text-left text-[11px] font-semibold ${spoilers ? tag.cls : 'text-muted'}`} title={spoilers ? tag.title : undefined}>
            {spoilers ? tag.label : ''}
          </span>
        </div>
      </td>
      <td className="hidden px-3 text-xs text-neutral-400 xl:table-cell">
        <span className="block max-w-[160px] truncate">{r.college || '—'}</span>
      </td>
      {signature && (
        <td className="px-3">
          <span className="flex items-center gap-1">
            {keyAttrsForPosition(r.positionId).map(([k, label]) => {
              const v = r.ratings?.[k];
              return (
                <span key={k} className="inline-flex h-5 items-center gap-1 rounded bg-black/30 px-1.5 text-[11px] ring-1 ring-white/[0.05]" title={k}>
                  <span className="font-semibold text-neutral-500">{label}</span>
                  <span className={`tabular-nums font-semibold ${spoilers && v != null ? attrTone(v) : 'text-neutral-600'}`}>{spoilers ? (v ?? '—') : '?'}</span>
                </span>
              );
            })}
          </span>
        </td>
      )}
      {cols.map((c) => {
        const v = r.ratings?.[c.key];
        return (
          <td key={c.id} className="px-2 text-center text-xs tabular-nums">
            {spoilers ? <span className={v == null ? 'text-neutral-600' : attrTone(v)}>{v ?? '—'}</span> : <span className="text-neutral-700">?</span>}
          </td>
        );
      })}
      <td aria-hidden />
    </tr>
  );
});

/** A round band: sits between rounds when the board is grouped, same height as
 *  a row so the virtual window stays a fixed grid. */
function RoundBand({ round, count, elite, xf, spoilers }: { round: number | null; count: number; elite: number; xf: number; spoilers: boolean }) {
  return (
    <tr style={{ height: ROW_H }} className="bg-primary/[0.07]">
      <td colSpan={99} className="px-3">
        <span className="flex items-center gap-3 text-[11px] font-bold uppercase tracking-[0.12em] text-primary-light">
          <span>{round ? `Round ${round}` : 'Undrafted'}</span>
          <span className="font-semibold tracking-wide text-neutral-500">{count} pick{count === 1 ? '' : 's'}</span>
          {spoilers && elite > 0 && <span className="font-semibold tracking-wide text-success-light">{elite} rated 80+</span>}
          {spoilers && xf > 0 && <span className="font-semibold tracking-wide text-red-300">{xf} X-Factor{xf === 1 ? '' : 's'}</span>}
        </span>
      </td>
    </tr>
  );
}

type Item = { kind: 'row'; r: Row } | { kind: 'band'; key: string; round: number | null; count: number; elite: number; xf: number };

export function PlayerTable({
  rows,
  selectedId,
  onRowClick,
  focusName,
  sort,
  onSort,
  spoilers = true,
  columns = 'core',
  pos = 'ALL',
  groupRounds = false,
  selectOnFocus = false,
}: {
  rows: Row[];
  selectedId: number | null;
  onRowClick: (id: number) => void;
  focusName?: string | null;
  sort?: string;
  onSort?: (s: string) => void;
  /** false hides overall, dev trait, wAV and attributes (blind scouting). */
  spoilers?: boolean;
  columns?: ColumnPreset;
  /** The board's position filter, so the Position preset knows which group to show. */
  pos?: string;
  /** Ticker mode: round bands between rounds (draft order only) and a numeral pick rail. */
  groupRounds?: boolean;
  /** Scout desk: moving the highlight with the arrow keys also selects the row. */
  selectOnFocus?: boolean;
}) {
  const maxWav = useMemo(() => Math.max(1, ...rows.map((r) => r.wav ?? 0)), [rows]);
  const { cols, signature } = useMemo(() => columnsFor(columns, pos, rows), [columns, pos, rows]);

  /* ---- Items: rows, with round bands slotted in when grouped in draft order. ---- */
  const inPickOrder = (sort ?? 'pick').replace(/^-/, '') === 'pick';
  const ticker = groupRounds && inPickOrder;
  const { items, indexOfRow } = useMemo(() => {
    const idx = new Map<number, number>();
    if (!ticker) {
      rows.forEach((r, i) => idx.set(r.id, i));
      return { items: rows.map((r): Item => ({ kind: 'row', r })), indexOfRow: idx };
    }
    const out: Item[] = [];
    let i = 0;
    while (i < rows.length) {
      const round = roundOf(rows[i]);
      let j = i;
      let elite = 0;
      let xf = 0;
      while (j < rows.length && roundOf(rows[j]) === round) {
        if (rows[j].overall >= 80) elite++;
        if (rows[j].devTrait === 3) xf++;
        j++;
      }
      out.push({ kind: 'band', key: `band-${round ?? 'none'}-${i}`, round, count: j - i, elite, xf });
      for (let k = i; k < j; k++) { idx.set(rows[k].id, out.length); out.push({ kind: 'row', r: rows[k] }); }
      i = j;
    }
    return { items: out, indexOfRow: idx };
  }, [rows, ticker]);

  /* ---- Virtual window: only the rows in view (plus a margin) exist in the DOM. ---- */
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => { if (el.clientHeight > 0) setHeight(el.clientHeight); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // A filter that shrinks the list leaves the scroll past its end: start over from the top.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollTop > Math.max(0, items.length * ROW_H - el.clientHeight)) { el.scrollTop = 0; setScrollTop(0); }
  }, [items.length]);
  const raf = useRef(0);
  const onScroll = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => { if (scrollRef.current) setScrollTop(scrollRef.current.scrollTop); });
  }, []);
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(items.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);
  const ensureVisible = useCallback((idx: number, center = false) => {
    const el = scrollRef.current;
    if (!el) return;
    const top = idx * ROW_H;
    if (center) { el.scrollTop = Math.max(0, top - el.clientHeight / 2 + ROW_H); return; }
    const head = 40; // sticky header
    if (top < el.scrollTop + head) el.scrollTop = top - head;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  }, []);

  /* ---- Roving-tabindex keyboard navigation. ---- */
  const [activeId, setActiveId] = useState<number | null>(null);
  const effActive = activeId != null && rows.some((r) => r.id === activeId) ? activeId : (rows[0]?.id ?? null);
  const rowRefs = useRef(new Map<number, HTMLTableRowElement>());
  const setRef = useCallback((id: number, el: HTMLTableRowElement | null) => {
    if (el) rowRefs.current.set(id, el);
    else rowRefs.current.delete(id);
  }, []);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (selectOnFocus) return;
    if (selectedId == null && wasOpen.current && effActive != null) rowRefs.current.get(effActive)?.focus();
    wasOpen.current = selectedId != null;
  }, [selectedId, effActive, selectOnFocus]);

  const moveActive = useCallback((from: number, delta: number) => {
    const idx = rows.findIndex((r) => r.id === from);
    const next = rows[idx + delta];
    if (!next) return;
    setActiveId(next.id);
    ensureVisible(indexOfRow.get(next.id) ?? idx + delta);
    // The target row may not exist until the window re-renders around it.
    requestAnimationFrame(() => rowRefs.current.get(next.id)?.focus({ preventScroll: true }));
  }, [rows, ensureVisible, indexOfRow]);
  const onKey = useCallback((e: KeyboardEvent<HTMLTableRowElement>, id: number) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(id, 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(id, -1); }
    else if (e.key === 'PageDown') { e.preventDefault(); moveActive(id, 12); }
    else if (e.key === 'PageUp') { e.preventDefault(); moveActive(id, -12); }
    else if (e.key === 'Enter') { e.preventDefault(); onRowClick(id); }
  }, [moveActive, onRowClick]);
  const onActivate = useCallback((id: number) => { setActiveId(id); onRowClick(id); }, [onRowClick]);
  const onFocusRow = useCallback((id: number) => { setActiveId(id); if (selectOnFocus) onRowClick(id); }, [selectOnFocus, onRowClick]);

  /* ---- Jump-to-player: scroll the searched row into the middle of the view. ---- */
  const focusId = useMemo(
    () => (focusName ? rows.find((r) => norm(`${r.firstName}${r.lastName}`) === focusName)?.id ?? null : null),
    [rows, focusName]
  );
  useEffect(() => {
    if (focusId == null) return;
    const idx = indexOfRow.get(focusId);
    if (idx != null) ensureVisible(idx, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  /* ---- Reveal animation: chips flip in when spoilers switch on. ---- */
  const [reveal, setReveal] = useState(false);
  const prevSpoilers = useRef(spoilers);
  useEffect(() => {
    if (spoilers && !prevSpoilers.current) {
      setReveal(true);
      const t = setTimeout(() => setReveal(false), 700);
      return () => clearTimeout(t);
    }
    prevSpoilers.current = spoilers;
  }, [spoilers]);
  useEffect(() => { prevSpoilers.current = spoilers; }, [spoilers]);

  const th = 'h-10 px-3 text-[11px] font-bold uppercase tracking-[0.12em]';
  const minWidth = 760 + (signature ? 340 : 0) + cols.length * 46;

  return (
    <div ref={scrollRef} onScroll={onScroll} className="h-full min-h-0 overflow-auto">
      <table className="w-full border-separate border-spacing-0 text-sm" style={{ minWidth }}>
        <thead className="sticky top-0 z-10 text-neutral-500">
          <tr className="bg-surface-1 shadow-[0_1px_0_rgba(255,255,255,0.06)]">
            <th className="w-[3px] p-0" aria-hidden />
            <SortTh id="pick" sort={sort} onSort={onSort} className={`${th} w-12 text-right`}>#</SortTh>
            <SortTh id="team" sort={sort} onSort={onSort} className={`${th} w-12 text-center`}>Team</SortTh>
            <SortTh id="name" sort={sort} onSort={onSort} className={`${th} w-60 text-left`}>Player</SortTh>
            <SortTh id="pos" sort={sort} onSort={onSort} className={`${th} w-16 text-left`}>Pos</SortTh>
            <SortTh id="ovr" locked={!spoilers} sort={sort} onSort={onSort} className={`${th} w-16 text-center`}>OVR</SortTh>
            <SortTh id="dev" locked={!spoilers} sort={sort} onSort={onSort} className={`${th} w-14 text-center`}>Dev</SortTh>
            <SortTh id="wav" locked={!spoilers} sort={sort} onSort={onSort} className={`${th} w-32 text-right`}>wAV</SortTh>
            <th className={`${th} hidden w-44 text-left font-semibold xl:table-cell`}>College</th>
            {signature && <th className={`${th} text-left font-semibold`} title="The signature ratings for each player's position">Signature</th>}
            {cols.map((c) => (
              <SortTh key={c.id} id={c.id} locked={!spoilers} sort={sort} onSort={onSort} className={`${th} w-12 text-center`}>
                {c.label}
              </SortTh>
            ))}
            <th aria-hidden className="w-auto" />
          </tr>
        </thead>
        <tbody>
          {start > 0 && <tr aria-hidden style={{ height: start * ROW_H }}><td /></tr>}
          {items.slice(start, end).map((it) =>
            it.kind === 'band' ? (
              <RoundBand key={it.key} round={it.round} count={it.count} elite={it.elite} xf={it.xf} spoilers={spoilers} />
            ) : (
              <BoardRow
                key={it.r.id}
                r={it.r}
                active={it.r.id === selectedId}
                highlighted={it.r.id === effActive}
                focused={it.r.id === focusId}
                spoilers={spoilers}
                reveal={reveal}
                cols={cols}
                signature={signature}
                ticker={ticker}
                maxWav={maxWav}
                onActivate={onActivate}
                onFocusRow={onFocusRow}
                onKey={onKey}
                setRef={setRef}
              />
            )
          )}
          {end < items.length && <tr aria-hidden style={{ height: (items.length - end) * ROW_H }}><td /></tr>}
          {rows.length === 0 && (
            <tr>
              <td colSpan={10 + cols.length} className="px-3 py-16 text-center text-muted">
                <div className="text-sm">No players match the current filter.</div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
