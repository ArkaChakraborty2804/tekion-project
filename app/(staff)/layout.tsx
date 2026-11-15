import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { fontVars } from '@/lib/fonts';
import '../globals.css';

export const metadata: Metadata = {
  title: 'TekOrbit · Post-Purchase Loyalty Journey Orchestrator',
  description: 'Coordinates post-purchase service, offers and trade-in touchpoints into one consented, human-approved customer journey.',
};

export default function StaffLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`dark ${fontVars}`} suppressHydrationWarning>
      <body className="antialiased bg-[#F6F8FB] dark:bg-[#080B11] text-slate-900 dark:text-slate-100 selection:bg-blue-600/30">{children}</body>
    </html>
  );
}
