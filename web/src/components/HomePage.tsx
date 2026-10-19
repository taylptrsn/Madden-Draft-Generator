import type { AppView } from '../App';
import { NAME } from '../brand';
import { Icon, ICONS } from './ui';

function ModePanel({
  accent,
  icon,
  title,
  tagline,
  features,
  onClick,
  index,
}: {
  accent: 'blue' | 'gold' | 'purple';
  icon: string;
  title: string;
  tagline: string;
  features: string[];
  onClick: () => void;
  index: number;
}) {
  // Two committed accents so the panels read as distinct doors, not a card grid.
  const a =
    accent === 'blue'
      ? {
          ring: 'hover:border-primary/60 focus-visible:border-primary/70',
          glow: 'hover:shadow-[0_0_0_1px_rgba(58,111,224,0.18),0_16px_36px_-20px_rgba(58,111,224,0.35)]',
          chip: 'bg-primary/12 text-primary-light ring-1 ring-primary/22',
          dot: 'bg-primary-light',
          cta: 'text-primary-light',
          beam: 'from-primary/14',
        }
      : accent === 'purple'
        ? {
            ring: 'hover:border-purple-400/60 focus-visible:border-purple-400/70',
            glow: 'hover:shadow-[0_0_0_1px_rgba(168,85,247,0.18),0_16px_36px_-20px_rgba(168,85,247,0.35)]',
            chip: 'bg-purple-500/12 text-purple-300 ring-1 ring-purple-500/22',
            dot: 'bg-purple-400',
            cta: 'text-purple-300',
            beam: 'from-purple-500/14',
          }
        : {
            ring: 'hover:border-gold/60 focus-visible:border-gold/70',
            glow: 'hover:shadow-[0_0_0_1px_rgba(245,197,24,0.16),0_16px_36px_-20px_rgba(245,197,24,0.28)]',
            chip: 'bg-gold/12 text-gold ring-1 ring-gold/22',
            dot: 'bg-gold',
            cta: 'text-gold',
            beam: 'from-gold/12',
          };

  return (
    <button
      onClick={onClick}
      style={{ ['--i' as string]: index + 2 }}
      className={`glass group relative flex flex-col overflow-hidden rounded-xl p-6 text-left transition-colors duration-200 motion-reduce:transition-colors ${a.ring} ${a.glow}`}
    >
      <span aria-hidden className={`pointer-events-none absolute -left-12 -top-12 h-36 w-36 rounded-full bg-gradient-to-br ${a.beam} to-transparent opacity-30 blur-2xl transition-opacity duration-300 group-hover:opacity-55`} />
      <span className={`relative grid h-10 w-10 place-items-center rounded-lg ${a.chip}`}>
        <Icon path={icon} className="h-5 w-5" strokeWidth={2} />
      </span>

      <h2 className="relative mt-4 font-display text-lg font-semibold text-neutral-50">{title}</h2>
      <p className="relative mt-1 text-sm leading-relaxed text-muted">{tagline}</p>

      <ul className="relative mt-4 flex flex-col gap-1.5 text-[13px] text-neutral-300">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2.5">
            <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${a.dot}`} />
            {f}
          </li>
        ))}
      </ul>

      <span className={`relative mt-auto inline-flex items-center gap-1.5 pt-5 text-sm font-medium ${a.cta}`}>
        Open
        <Icon path={ICONS.arrowRight} className="h-4 w-4 transition-transform duration-200 ease-out group-hover:translate-x-0.5 motion-reduce:transform-none" strokeWidth={2.2} />
      </span>
    </button>
  );
}

export function HomePage({ onSelect, onOpenFreaks, franchiseEnabled, title = `Madden ${NAME}` }: { onSelect: (v: AppView) => void; onOpenFreaks?: () => void; franchiseEnabled: boolean; title?: string }) {
  return (
    <div className="relative h-full overflow-auto">
      {/* Hero art: the generated stadium plate, faded into the shell at the bottom. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[520px] overflow-hidden">
        <img src="/art/hero.jpg" alt="" className="h-full w-full object-cover object-top opacity-55" style={{ animation: 'fade-in 0.6s ease-out both' }} />
        <div className="absolute inset-0 bg-gradient-to-b from-surface-0/20 via-surface-0/55 to-surface-0" />
        <div className="absolute inset-0 grain" />
      </div>

      <div className={`stagger relative mx-auto flex min-h-full w-full flex-col justify-center px-8 py-12 ${franchiseEnabled ? 'max-w-6xl' : 'max-w-5xl'}`}>
        <div className="max-w-2xl" style={{ ['--i' as string]: 0 }}>
          <h1 className="font-display text-3xl font-bold leading-[1.08] text-neutral-50 sm:text-4xl" style={{ textWrap: 'balance' }}>
            {title}
          </h1>
          <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-muted" style={{ ['--i' as string]: 1 }}>
            {franchiseEnabled
              ? 'Generate historically-rated draft classes, build a custom roster, or run tools for your franchise. Choose where to start.'
              : 'Generate historically-rated draft classes or build a custom roster. Choose where to start.'}
          </p>
        </div>

        <div className={`mt-8 grid grid-cols-1 gap-3 md:grid-cols-2 ${franchiseEnabled ? 'xl:grid-cols-4' : 'xl:grid-cols-3'}`}>
          <ModePanel
            index={0}
            accent="blue"
            icon={ICONS.board}
            title="Draft Classes"
            tagline="Build importable draft classes from real NFL history."
            features={[
              'Every draft 1936–2026, rated from career wAV',
              'Per-player editor: ratings, positions, portraits, gear',
              'Table, card and draft-board views',
              'Save straight into Madden',
            ]}
            onClick={() => onSelect('draft')}
          />
          <ModePanel
            index={1}
            accent="purple"
            icon={ICONS.sparkles}
            title="Freak Lab 🦄"
            tagline="Generate procedural unicorns & anomalies calibrated to 1936–2026."
            features={[
              '29 Freak archetypes, dual hybrids & 3-way super-fusions',
              'Calibrated to 95th/99th percentile historical tail stats',
              '6×6 Cholesky physical correlation sampler',
              'Standalone or overlay onto any 1936–2026 draft class',
            ]}
            onClick={() => {
              if (onOpenFreaks) onOpenFreaks();
              else onSelect('draft');
            }}
          />
          <ModePanel
            index={2}
            accent="blue"
            icon={ICONS.users}
            title="Rosters"
            tagline="Build a custom Madden 27 roster from any ROSTER save."
            features={[
              'Move, cut and sign players across all 32 teams',
              'Edit ratings, positions, dev traits and gear',
              'Exports a new ROSTER file; the base is never touched',
            ]}
            onClick={() => onSelect('rosters')}
          />
          {franchiseEnabled && (
            <ModePanel
              index={3}
              accent="gold"
              icon={ICONS.shield}
              title="Franchise Tools"
              tagline="Reset the cap and feed your franchise fresh draft classes."
              features={[
                'Salary-cap reset: clear dead money, open cap room',
                'No-repeat random draft picker with year range',
                'Reads your CAREER save directly',
                'Always writes a safe new file — original untouched',
              ]}
              onClick={() => onSelect('franchise')}
            />
          )}
        </div>
      </div>
    </div>
  );
}
