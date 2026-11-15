import { route } from '@/lib/api/http';
import { queue } from '@/lib/api/staff';

export const dynamic = 'force-dynamic';
export const GET = route(queue);
