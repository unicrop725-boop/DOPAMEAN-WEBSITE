'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Step = 'credentials' | 'totp';

export function LoginForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('credentials');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onCredentials(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const res = await authClient.signIn.email({
      email: String(form.get('email')),
      password: String(form.get('password')),
    });
    setBusy(false);
    if (res.error) {
      setError(
        res.error.status === 429
          ? 'Too many attempts. Try again later.'
          : 'Invalid email or password.',
      );
      return;
    }
    if (res.data && 'twoFactorRedirect' in res.data && res.data.twoFactorRedirect) {
      setStep('totp');
      return;
    }
    router.push('/admin');
    router.refresh();
  }

  async function onTotp(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const res = await authClient.twoFactor.verifyTotp({ code: String(form.get('code')) });
    setBusy(false);
    if (res.error) {
      setError('Invalid code.');
      return;
    }
    router.push('/admin');
    router.refresh();
  }

  if (step === 'totp') {
    return (
      <form onSubmit={onTotp} className="flex flex-col gap-4" aria-label="Two-factor code">
        <div className="flex flex-col gap-2">
          <Label htmlFor="code">Authenticator code</Label>
          <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" required />
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy}>
          {busy ? 'Verifying' : 'Verify'}
        </Button>
      </form>
    );
  }

  return (
    <form onSubmit={onCredentials} className="flex flex-col gap-4" aria-label="Sign in">
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="username" required />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? 'Signing in' : 'Sign in'}
      </Button>
    </form>
  );
}
