import { route } from '@/lib/api/http';
import { decideOpp } from '@/lib/api/staff';

export const dynamic = 'force-dynamic';
export const POST = route(decideOpp);
