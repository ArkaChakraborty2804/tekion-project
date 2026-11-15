import { route } from '@/lib/api/http';
import { rules, saveRules } from '@/lib/api/staff';

export const dynamic = 'force-dynamic';
export const GET = route(rules);
export const POST = route(saveRules);
