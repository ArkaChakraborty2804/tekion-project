import { route } from '@/lib/api/http';
import { publishRules } from '@/lib/api/staff';

export const dynamic = 'force-dynamic';
export const POST = route(publishRules);
