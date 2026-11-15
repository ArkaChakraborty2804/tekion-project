import { route } from '@/lib/api/http';
import { accuracyAnalytics } from '@/lib/api/staff';

export const dynamic = 'force-dynamic';
export const GET = route(accuracyAnalytics);
