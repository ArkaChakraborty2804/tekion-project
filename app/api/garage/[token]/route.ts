import { route } from '@/lib/api/http';
import { garagePassport } from '@/lib/api/customer';

export const dynamic = 'force-dynamic';
export const GET = route(garagePassport);
