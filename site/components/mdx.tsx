import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import type { MDXComponents } from 'mdx/types';
import { withBase } from '@/lib/shared';

interface ScreenshotProps {
  src: string;
  alt: string;
  caption: string;
  width: number;
  height: number;
  /** Narrowest it's drawn; below that it scrolls sideways instead of shrinking past legibility. */
  minWidth?: number;
  /** Widest it's drawn, for small dialogs that look odd stretched to the page width. */
  maxWidth?: number;
}

/** A screenshot of the app, with a caption. Opens at full size when clicked. */
function Screenshot({ src, alt, caption, width, height, minWidth, maxWidth }: ScreenshotProps) {
  const url = withBase(src);
  return (
    <figure className="not-prose my-6" style={maxWidth ? { maxWidth } : undefined}>
      <div className="overflow-x-auto rounded-lg border bg-fd-card">
        <a href={url} target="_blank" rel="noreferrer" className="block" style={minWidth ? { minWidth } : undefined}>
          <img src={url} alt={alt} width={width} height={height} loading="lazy" className="block h-auto w-full" />
        </a>
      </div>
      <figcaption className="mt-2 text-sm text-fd-muted-foreground">{caption}</figcaption>
    </figure>
  );
}

interface ClipProps {
  src: string;
  poster: string;
  /** What the recording shows, for screen readers. */
  label: string;
  caption: string;
  width: number;
  height: number;
}

/** A short screen recording. It doesn't play until asked, and has no sound. */
function Clip({ src, poster, label, caption, width, height }: ClipProps) {
  return (
    <figure className="not-prose my-6">
      <video
        src={withBase(src)}
        poster={withBase(poster)}
        aria-label={label}
        width={width}
        height={height}
        controls
        muted
        playsInline
        preload="none"
        className="block h-auto w-full rounded-lg border bg-fd-card"
      />
      <figcaption className="mt-2 text-sm text-fd-muted-foreground">{caption}</figcaption>
    </figure>
  );
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Accordion,
    Accordions,
    Step,
    Steps,
    Tab,
    Tabs,
    Screenshot,
    Clip,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
