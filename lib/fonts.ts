/** Self-hosted at build time by next/font (no runtime request to Google; CSP stays font-src 'self'). */
import { Inter, JetBrains_Mono, Plus_Jakarta_Sans } from 'next/font/google';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const jakarta = Plus_Jakarta_Sans({ subsets: ['latin'], weight: ['500', '600', '700', '800'], variable: '--font-jakarta', display: 'swap' });
const jetbrains = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-jetbrains', display: 'swap' });

export const fontVars = `${inter.variable} ${jakarta.variable} ${jetbrains.variable}`;
