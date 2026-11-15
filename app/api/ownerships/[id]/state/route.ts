import { route } from '@/lib/api/http';
import { ownershipState } from '@/lib/api/staff';

export const dynamic = 'force-dynamic';
export const POST = route(ownershipState);
