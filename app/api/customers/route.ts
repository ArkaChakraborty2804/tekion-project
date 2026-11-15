import { route } from '@/lib/api/http';
import { customers } from '@/lib/api/staff';

export const dynamic = 'force-dynamic';
export const GET = route(customers);
