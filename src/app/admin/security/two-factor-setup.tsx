'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Enrollment = { totpURI: string; backupCodes: string[] };

export function TwoFactorSetup() {
  const router = useRouter();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function begin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const res = await authClient.twoFactor.enable({ password: String(form.get('password')) });
    setBusy(false);
    if (res.error || !res.data || res.data.method !== 'totp') {
      setError('Could not start setup. Check your password.');
      return;
    }
    setEnrollment({ totpURI: res.data.totpURI, backupCodes: res.data.backupCodes });
  }

  async function confirm(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const res = await authClient.twoFactor.verifyTotp({ code: String(form.get('code')) });
    setBusy(false);
    if (res.error) {
      setError('That code is not valid. Try the next one.');
      return;
    }
    router.push('/admin');
    router.refresh();
  }

  if (!enrollment) {
    return (
      <form onSubmit={begin} className="flex flex-col gap-4" aria-label="Start two-factor setup">
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
          Continue
        </Button>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">
        Add this key to your authenticator app (open the link on a phone, or copy it), then enter
        the 6-digit code.
      </p>
      <a className="break-all font-mono text-xs underline" href={enrollment.totpURI}>
        {enrollment.totpURI}
      </a>
      <div>
        <p className="font-mono text-xs uppercase">Backup codes (store them safely)</p>
        <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs">
          {enrollment.backupCodes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </div>
      <form
        onSubmit={confirm}
        className="flex flex-col gap-4"
        aria-label="Confirm authenticator code"
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="code">Code</Label>
          <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" required />
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy}>
          Verify and enable
        </Button>
      </form>
    </div>
  );
}
