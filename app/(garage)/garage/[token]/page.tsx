import Garage from '@/components/customer/Garage';
import { customerPagesEnabled } from '@/lib/server/pages';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!customerPagesEnabled()) {
    return <main className="min-h-screen flex items-center justify-center p-6"><p role="alert" className="text-sm text-rose-500">The Digital Garage is disabled: the server is not loopback-bound.</p></main>;
  }
  return <Garage token={token} />;
}
