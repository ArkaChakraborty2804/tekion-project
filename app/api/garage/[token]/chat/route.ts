import { route } from '@/lib/api/http';
import { garageChatRoute } from '@/lib/api/customer';

export const dynamic = 'force-dynamic';
export const POST = route(garageChatRoute);
