import { route } from '@/lib/api/http';
import { garageBook } from '@/lib/api/customer';

export const dynamic = 'force-dynamic';
export const POST = route(garageBook);
