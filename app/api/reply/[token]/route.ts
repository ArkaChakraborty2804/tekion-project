import { route } from '@/lib/api/http';
import { replyInfo } from '@/lib/api/customer';

export const dynamic = 'force-dynamic';
export const GET = route(replyInfo);
