import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { fontVars } from '@/lib/fonts';
import '../globals.css';

export const metadata: Metadata = { title: 'Reply to your dealer', robots: { index: false, follow: false } };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#080B11' };

export default function ReplyLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`dark ${fontVars}`}>
      <body className="antialiased bg-[#F6F8FB] dark:bg-[#080B11] text-slate-900 dark:text-slate-100 selection:bg-blue-600/30">{children}</body>
    </html>
  );
}
