import { route } from '@/lib/api/http';
import { caseDetail } from '@/lib/api/staff';

export const dynamic = 'force-dynamic';
export const GET = route(caseDetail);
