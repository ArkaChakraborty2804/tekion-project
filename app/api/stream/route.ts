import { route } from '@/lib/api/http';
import { stream } from '@/lib/api/staff';

export const dynamic = 'force-dynamic';
export const GET = route(stream);
