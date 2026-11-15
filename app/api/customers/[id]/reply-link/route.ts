import { route } from '@/lib/api/http';
import { replyLink } from '@/lib/api/staff';

export const dynamic = 'force-dynamic';
export const POST = route(replyLink);
