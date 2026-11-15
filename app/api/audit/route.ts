import { route } from '@/lib/api/http';
import { auditLog } from '@/lib/api/staff';

export const dynamic = 'force-dynamic';
export const GET = route(auditLog);
