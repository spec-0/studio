import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { Card as FumaCard, Cards as FumaCards } from 'fumadocs-ui/components/card';
import {
  Bot,
  BookOpen,
  Boxes,
  Download,
  FileCheck2,
  FolderGit2,
  KeyRound,
  Keyboard,
  LifeBuoy,
  ListChecks,
  MessagesSquare,
  Network,
  Plug,
  Rocket,
  Send,
  Server,
  ShieldCheck,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';
import { DownloadButton } from './download-button';

/** GitHub's mark, which lucide no longer ships. */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
import { repoUrl, withBase } from '@/lib/shared';

/** Studio's version, from the package.json at the root of the repository the site is built from. */
function studioVersion(): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

/** The icons a page can name in `<Card icon="…">`. */
const ICONS: Record<string, LucideIcon | typeof GithubMark> = {
  agent: Bot,
  book: BookOpen,
  chat: MessagesSquare,
  check: FileCheck2,
  collection: ListChecks,
  download: Download,
  github: GithubMark,
  code: FolderGit2,
  graph: Waypoints,
  key: KeyRound,
  keyboard: Keyboard,
  help: LifeBuoy,
  mock: Server,
  mcp: Plug,
  network: Network,
  rocket: Rocket,
  schema: Boxes,
  send: Send,
  shield: ShieldCheck,
};

/**
 * A card linking to a page, with an icon named from {@link ICONS}. The text inside
 * it is its description.
 */
export function Card({ icon, title, href, children }: { icon?: string; title: string; href?: string; children?: ReactNode }) {
  const Icon = icon ? ICONS[icon] : undefined;
  return (
    <FumaCard title={title} href={href} icon={Icon ? <Icon /> : undefined}>
      {children}
    </FumaCard>
  );
}

/** A grid of cards: two across, or three with `columns={3}`. On a narrow page, one. */
export function Cards({ columns, children }: { columns?: 2 | 3; children: ReactNode }) {
  return <FumaCards className={columns === 3 ? 'xl:grid-cols-3' : undefined}>{children}</FumaCards>;
}

/** The app icon: the Spec0 mark in white on brand violet, as on the dock. */
function AppIcon() {
  return (
    <span className="grid size-11 shrink-0 place-items-center rounded-[11px] bg-[#5B4CF5] shadow-sm" aria-hidden>
      <svg viewBox="0 0 28 30" className="h-6 w-auto" fill="#fff">
        <path d="M14 24C9.75758 24 7 24 7 15C7 6 9.75758 6 14 6C18.2424 6 21 6 21 15C21 24 18.2424 24 14 24ZM9.87879 18.024L17.2424 9.12C16.5758 8.256 15.7576 8.16 14 8.16C11.2727 8.16 9.72727 8.16 9.72727 15C9.72727 16.224 9.78788 17.208 9.87879 18.024ZM14 21.84C16.7273 21.84 18.2727 21.84 18.2727 15C18.2727 13.776 18.2121 12.816 18.1212 12L10.7576 20.88C11.4242 21.744 12.303 21.84 14 21.84Z" />
        <path d="M3.82593 30C1.71293 30 0 28.0102 0 25.5556V4.44444C0 1.98985 1.71293 0 3.82593 0H10.4845C11.0331 0 10.9995 0.47386 10.9995 1.11111C10.9995 1.74836 11.0486 2 10.5 2H5C2.887 2 1.91296 3.10096 1.91296 5.55556V24.4444C1.91296 26.9124 2.87556 28.019 5 28H10.4883C11.0377 27.9951 10.9995 28.2506 10.9995 28.8889C10.9995 29.5237 11.0348 30 10.4883 30H3.82593Z" />
        <path d="M24.1741 30C26.2871 30 28 28.0102 28 25.5556V4.44444C28 1.98985 26.2871 0 24.1741 0H17.5155C16.9669 0 17.0005 0.47386 17.0005 1.11111C17.0005 1.74836 16.9514 2 17.5 2H23C25.113 2 26.087 3.10096 26.087 5.55556V24.4444C26.087 26.9124 25.1244 28.019 23 28H17.5117C16.9623 27.9951 17.0005 28.2506 17.0005 28.8889C17.0005 29.5237 16.9652 30 17.5117 30H24.1741Z" />
      </svg>
    </span>
  );
}

/** The top of the home page: what Studio is, and the way in. */
export function Hero({ title, lead }: { title: string; lead: string }) {
  const version = studioVersion();
  return (
    <section className="not-prose relative mb-10 overflow-hidden rounded-2xl border bg-fd-card px-6 py-10 sm:px-10 sm:py-14">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,var(--color-fd-primary)_0%,transparent_55%)] opacity-15"
      />
      <div className="relative max-w-2xl">
        <div className="mb-6 flex items-center gap-3">
          <AppIcon />
          <div className="leading-tight">
            <div className="font-semibold">Spec0 Studio</div>
            <div className="text-xs text-fd-muted-foreground">
              Spec0 is said &ldquo;spec zero&rdquo;
            </div>
          </div>
        </div>
        <a
          href={`${repoUrl}/releases/latest`}
          className="mb-5 inline-flex items-center gap-2 rounded-full border bg-fd-background px-3 py-1 text-xs text-fd-muted-foreground transition-colors hover:text-fd-foreground"
        >
          {version && <span className="font-medium text-fd-primary">v{version}</span>}
          <span>Free and open source · MIT</span>
          <ArrowRight className="size-3" aria-hidden />
        </a>
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title}</h1>
        <p className="mt-4 text-base text-fd-muted-foreground text-pretty sm:text-lg">{lead}</p>
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <DownloadButton />
          <a
            href={withBase('/quick-start/')}
            className="inline-flex items-center gap-2 rounded-lg border bg-fd-background px-4 py-2.5 text-sm font-medium transition-colors hover:bg-fd-accent"
          >
            Quick start <ArrowRight className="size-4" aria-hidden />
          </a>
          <a
            href={repoUrl}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium text-fd-muted-foreground transition-colors hover:text-fd-foreground"
          >
            <GithubMark className="size-4" /> GitHub
          </a>
        </div>
        <p className="mt-5 text-xs text-fd-muted-foreground">
          macOS, Windows and Linux · No account · No telemetry ·{' '}
          <a href={withBase('/install/')} className="underline underline-offset-2 hover:text-fd-foreground">
            Other downloads and checksums
          </a>
        </p>
      </div>
    </section>
  );
}
