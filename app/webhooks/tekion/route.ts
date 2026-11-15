import { route } from '@/lib/api/http';
import { tekionWebhook } from '@/lib/api/webhooks';

export const dynamic = 'force-dynamic';
export const POST = route(tekionWebhook);
