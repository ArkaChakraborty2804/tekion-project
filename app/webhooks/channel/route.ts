import { route } from '@/lib/api/http';
import { channelWebhook } from '@/lib/api/webhooks';

export const dynamic = 'force-dynamic';
export const POST = route(channelWebhook);
