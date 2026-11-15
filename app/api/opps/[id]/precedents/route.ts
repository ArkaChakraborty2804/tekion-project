import { route } from '@/lib/api/http';
import { precedents } from '@/lib/api/staff';

export const dynamic = 'force-dynamic';
export const GET = route(precedents);
