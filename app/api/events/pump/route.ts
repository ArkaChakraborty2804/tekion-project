import { route } from '@/lib/api/http';
import { pumpEvents } from '@/lib/api/staff';

export const dynamic = 'force-dynamic';
export const POST = route(pumpEvents);
