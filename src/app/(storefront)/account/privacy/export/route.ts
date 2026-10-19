import { getDb } from '@/db/client';
import { getSessionUser } from '@/lib/session';
import { exportCustomerData } from '@/modules/customers';

export const dynamic = 'force-dynamic';

/** Data export for the signed-in customer only: the user id comes from the session, never the URL. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return new Response('Unauthorized', { status: 401 });
  const data = await exportCustomerData(getDb(), user.id);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename="dopamean-my-data.json"',
      'cache-control': 'no-store',
    },
  });
}
