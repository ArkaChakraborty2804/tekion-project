import { route } from '@/lib/api/http';
import { mediaFile } from '@/lib/api/staff';

export const dynamic = 'force-dynamic';
export const GET = route(mediaFile);
