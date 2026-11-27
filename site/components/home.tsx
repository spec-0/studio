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
