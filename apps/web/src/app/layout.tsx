import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { THEME_INIT_SCRIPT } from '@/lib/theme-script';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Brand OS', template: '%s | Brand OS' },
  description: 'A local-first studio for technical articles. AI is optional; nothing is published without your approval.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f4f2ee' },
    { media: '(prefers-color-scheme: dark)', color: '#191c19' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        {children}
      </body>
    </html>
  );
}
