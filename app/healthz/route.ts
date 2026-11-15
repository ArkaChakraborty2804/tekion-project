import { route } from '@/lib/api/http';
import { health } from '@/lib/api/staff';

export const dynamic = 'force-dynamic';
export const GET = route(health);
