import { route } from '@/lib/api/http';
import { devClock } from '@/lib/api/dev';

export const dynamic = 'force-dynamic';
export const POST = route(devClock);
