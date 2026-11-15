import { route } from '@/lib/api/http';
import { cases } from '@/lib/api/staff';

export const dynamic = 'force-dynamic';
export const GET = route(cases);
