import { toNextJsHandler } from 'better-auth/next-js';
import { getAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const handlers = () => toNextJsHandler(getAuth());

export const GET = (req: Request) => handlers().GET(req);
export const POST = (req: Request) => handlers().POST(req);
