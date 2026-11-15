import { route } from '@/lib/api/http';
import { devScan } from '@/lib/api/dev';

export const dynamic = 'force-dynamic';
export const POST = route(devScan);
