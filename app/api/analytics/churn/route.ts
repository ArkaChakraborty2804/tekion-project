import { route } from '@/lib/api/http';
import { churnAnalytics } from '@/lib/api/staff';

export const dynamic = 'force-dynamic';
export const GET = route(churnAnalytics);
