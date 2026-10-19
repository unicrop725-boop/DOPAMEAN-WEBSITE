import { LoginForm } from './login-form';

export const metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="font-mono text-lg uppercase">DOPAMEAN [ADMIN]</h1>
      {error === 'not-staff' && (
        <p role="alert" className="border border-danger p-3 text-sm text-danger">
          This account does not have admin access.
        </p>
      )}
      <LoginForm />
    </main>
  );
}
