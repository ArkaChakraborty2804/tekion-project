import { route } from '@/lib/api/http';
import { garageDescribe } from '@/lib/api/customer';

export const dynamic = 'force-dynamic';
export const POST = route(garageDescribe);
