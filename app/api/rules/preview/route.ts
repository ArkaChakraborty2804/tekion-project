import { route } from '@/lib/api/http';
import { previewRules } from '@/lib/api/staff';

export const dynamic = 'force-dynamic';
export const POST = route(previewRules);
