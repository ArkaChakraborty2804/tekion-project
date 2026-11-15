import { route } from '@/lib/api/http';
import { devUsers } from '@/lib/api/dev';

export const dynamic = 'force-dynamic';
export const GET = route(devUsers);
