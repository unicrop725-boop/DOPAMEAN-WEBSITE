// Bootstrap the first Owner. Refuses to run if an Owner already exists.
//   OWNER_EMAIL=you@example.com OWNER_NAME="You" OWNER_PASSWORD='...' npm run staff:create-owner
import { closeDb, getDb } from '../src/db/client';
import { bootstrapOwner } from '../src/modules/staff';

async function main() {
  const { OWNER_EMAIL, OWNER_NAME, OWNER_PASSWORD } = process.env;
  if (!OWNER_EMAIL || !OWNER_NAME || !OWNER_PASSWORD) {
    throw new Error('Set OWNER_EMAIL, OWNER_NAME and OWNER_PASSWORD (min 10 chars).');
  }
  const { userId } = await bootstrapOwner(getDb(), {
    email: OWNER_EMAIL,
    name: OWNER_NAME,
    password: OWNER_PASSWORD,
  });
  console.log(
    `owner created: ${userId}. Sign in at /admin/login; you will be asked to set up 2FA.`,
  );
  await closeDb();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
