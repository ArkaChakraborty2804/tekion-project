import { route } from '@/lib/api/http';
import { metrics } from '@/lib/api/staff';

export const dynamic = 'force-dynamic';
export const GET = route(metrics);
