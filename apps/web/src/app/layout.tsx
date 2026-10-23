import type { Metadata, Viewport } from 'next';
import { Bricolage_Grotesque, IBM_Plex_Mono, Instrument_Sans, Newsreader } from 'next/font/google';
import type { ReactNode } from 'react';
import { THEME_INIT_SCRIPT } from '@/lib/theme-script';
import './globals.css';

// Self-hosted at build time by next/font: the browser never contacts a font service.
const bricolage = Bricolage_Grotesque({ subsets: ['latin'], display: 'swap', variable: '--font-bricolage' });
const instrument = Instrument_Sans({ subsets: ['latin'], display: 'swap', variable: '--font-instrument-sans' });
const plexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], display: 'swap', variable: '--font-plex-mono' });
const newsreader = Newsreader({ subsets: ['latin'], style: ['normal', 'italic'], display: 'swap', variable: '--font-newsreader' });

export const metadata: Metadata = {
  title: { default: 'Brand OS', template: '%s | Brand OS' },
  description: 'A local-first studio for technical articles. AI is optional; nothing is published without your approval.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f4ec' },
    { media: '(prefers-color-scheme: dark)', color: '#0e1a14' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${bricolage.variable} ${instrument.variable} ${plexMono.variable} ${newsreader.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        {children}
      </body>
    </html>
  );
}
