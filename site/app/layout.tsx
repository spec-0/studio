import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Provider } from '@/components/provider';
import { siteUrl, withBase } from '@/lib/shared';
import './global.css';

const inter = Inter({
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL(`${siteUrl}/`),
  title: {
    template: '%s · Spec0 Studio',
    default: 'Spec0 Studio',
  },
  description: 'The user guide for Spec0 Studio, a free, open source desktop app for calling and testing APIs from their OpenAPI spec.',
  icons: { icon: withBase('/brand/icon.png') },
  openGraph: {
    siteName: 'Spec0 Studio',
    type: 'website',
    images: [{ url: withBase('/brand/social-preview.png'), width: 1200, height: 630, alt: 'Spec0 Studio: call and test your APIs, straight from their OpenAPI spec' }],
  },
  twitter: { card: 'summary_large_image', images: [withBase('/brand/social-preview.png')] },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
