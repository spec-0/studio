import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { Download, Globe } from 'lucide-react';
import { downloadUrl, repoUrl, spec0Url, withBase } from './shared';

/** The Spec0 Studio wordmark, in the version that suits the theme. */
function Logo() {
  return (
    <>
      <img src={withBase('/brand/spec0-studio-light.svg')} alt="Spec0 Studio" className="h-6 w-auto dark:hidden" />
      <img src={withBase('/brand/spec0-studio-dark.svg')} alt="Spec0 Studio" className="hidden h-6 w-auto dark:block" />
    </>
  );
}

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <Logo />,
      url: '/',
    },
    githubUrl: repoUrl,
    links: [
      { text: 'Download', url: downloadUrl, icon: <Download />, external: true },
      { text: 'Spec0', url: spec0Url, icon: <Globe />, external: true },
    ],
  };
}
