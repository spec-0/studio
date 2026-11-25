'use client';

import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { repoUrl, withBase } from '@/lib/shared';

const latest = `${repoUrl}/releases/latest/download`;

/** The newest installer for each platform, by its fixed file name on every release. */
const DOWNLOADS = {
  macOS: `${latest}/spec0-studio-macos-universal.dmg`,
  Windows: `${latest}/spec0-studio-windows-x64-setup.exe`,
  Linux: `${latest}/spec0-studio-linux-x86_64.AppImage`,
} as const;

type Platform = keyof typeof DOWNLOADS;

function detect(): Platform | undefined {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const name = `${nav.userAgentData?.platform ?? ''} ${navigator.userAgent}`.toLowerCase();
  // Phones and tablets can't run Studio: send them to the install page instead.
  if (/iphone|ipad|android/.test(name)) return undefined;
  if (name.includes('mac')) return 'macOS';
  if (name.includes('win')) return 'Windows';
  if (name.includes('linux')) return 'Linux';
  return undefined;
}

/**
 * The main download button. The page is static, so it first renders as a link to the
 * install page, then becomes a direct download once the browser says which system
 * it's on.
 */
export function DownloadButton() {
  const [platform, setPlatform] = useState<Platform>();
  useEffect(() => setPlatform(detect()), []);
  const href = platform ? DOWNLOADS[platform] : withBase('/install/');
  return (
    <a
      href={href}
      className="inline-flex items-center gap-2 rounded-lg bg-fd-primary px-4 py-2.5 text-sm font-medium text-fd-primary-foreground shadow-sm transition-colors hover:bg-fd-primary/90"
    >
      <Download className="size-4" aria-hidden />
      {platform ? `Download for ${platform}` : 'Download'}
    </a>
  );
}
