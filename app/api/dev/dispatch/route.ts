import { route } from '@/lib/api/http';
import { devDispatch } from '@/lib/api/dev';

export const dynamic = 'force-dynamic';
export const POST = route(devDispatch);
