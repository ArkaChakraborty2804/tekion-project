import { route } from '@/lib/api/http';
import { replyMessage } from '@/lib/api/customer';

export const dynamic = 'force-dynamic';
export const POST = route(replyMessage);
