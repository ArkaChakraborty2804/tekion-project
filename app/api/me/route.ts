import { route } from '@/lib/api/http';
import { me } from '@/lib/api/staff';

export const dynamic = 'force-dynamic';
export const GET = route(me);
