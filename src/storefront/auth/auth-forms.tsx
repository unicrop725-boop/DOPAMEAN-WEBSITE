'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';

type Status = { kind: 'error' | 'success'; text: string } | null;

function Message({ status }: { status: Status }) {
  if (!status) return null;
  return (
    <p
      role={status.kind === 'error' ? 'alert' : 'status'}
      className={`sp-message sp-message--${status.kind}`}
    >
      {status.text}
    </p>
  );
}

function Field(props: {
  id: string;
  label: string;
  type?: string;
  autoComplete?: string;
  hint?: string;
  minLength?: number;
}) {
  return (
    <div className="sp-field">
      <label htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        name={props.id}
        type={props.type ?? 'text'}
        autoComplete={props.autoComplete}
        minLength={props.minLength}
        className="sp-input"
        required
        aria-describedby={props.hint ? `${props.id}-hint` : undefined}
      />
      {props.hint && (
        <span id={`${props.id}-hint`} className="sp-field-hint">
          {props.hint}
        </span>
      )}
    </div>
  );
}

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const [needsVerify, setNeedsVerify] = useState<string | null>(null);
  const [step, setStep] = useState<'credentials' | 'totp'>('credentials');

  async function onCredentials(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    setNeedsVerify(null);
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email'));
    const res = await authClient.signIn.email({ email, password: String(form.get('password')) });
    setBusy(false);
    if (res.error) {
      if (res.error.status === 403) {
        setNeedsVerify(email);
        setStatus({ kind: 'error', text: 'Please verify your email address before signing in.' });
      } else if (res.error.status === 429) {
        setStatus({ kind: 'error', text: 'Too many attempts. Please try again later.' });
      } else {
        setStatus({ kind: 'error', text: 'Invalid email or password.' });
      }
      return;
    }
    if (res.data && 'twoFactorRedirect' in res.data && res.data.twoFactorRedirect) {
      setStep('totp');
      return;
    }
    router.push(next);
    router.refresh();
  }

  async function onTotp(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    const form = new FormData(e.currentTarget);
    const res = await authClient.twoFactor.verifyTotp({ code: String(form.get('code')) });
    setBusy(false);
    if (res.error) {
      setStatus({ kind: 'error', text: 'Invalid code.' });
      return;
    }
    router.push(next);
    router.refresh();
  }

  async function resend() {
    if (!needsVerify) return;
    const res = await authClient.sendVerificationEmail({
      email: needsVerify,
      callbackURL: '/account?verified=1',
    });
    setStatus(
      res.error
        ? { kind: 'error', text: 'Could not send the email. Try again shortly.' }
        : { kind: 'success', text: 'Verification email sent. Check your inbox.' },
    );
  }

  if (step === 'totp') {
    return (
      <form className="sp-form" onSubmit={onTotp} aria-label="Two-factor code">
        <Message status={status} />
        <Field id="code" label="Authenticator code" autoComplete="one-time-code" />
        <button className="sp-btn" type="submit" disabled={busy}>
          {busy ? 'Verifying' : 'Verify'}
        </button>
      </form>
    );
  }

  return (
    <form className="sp-form" onSubmit={onCredentials} aria-label="Sign in">
      <Message status={status} />
      <Field id="email" label="Email" type="email" autoComplete="username" />
      <Field id="password" label="Password" type="password" autoComplete="current-password" />
      <div className="sp-actions">
        <button className="sp-btn" type="submit" disabled={busy}>
          {busy ? 'Signing in' : 'Sign in'}
        </button>
        {needsVerify && (
          <button className="sp-btn sp-btn--outline" type="button" onClick={resend}>
            Resend verification email
          </button>
        )}
      </div>
    </form>
  );
}

export function RegisterForm() {
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email'));
    const res = await authClient.signUp.email({
      name: String(form.get('name')),
      email,
      password: String(form.get('password')),
      callbackURL: '/account?verified=1',
    });
    setBusy(false);
    if (res.error) {
      setStatus({
        kind: 'error',
        text:
          res.error.status === 429
            ? 'Too many attempts. Please try again later.'
            : 'We could not create that account. If you already have one, sign in or reset your password.',
      });
      return;
    }
    setSentTo(email);
  }

  if (sentTo) {
    return (
      <div className="sp-box" role="status">
        <p className="sp-text">
          Check your inbox. We sent a verification link to {sentTo}. Open it to activate your
          account, then sign in.
        </p>
      </div>
    );
  }

  return (
    <form className="sp-form" onSubmit={onSubmit} aria-label="Create account">
      <Message status={status} />
      <Field id="name" label="Full name" autoComplete="name" />
      <Field id="email" label="Email" type="email" autoComplete="email" />
      <Field
        id="password"
        label="Password"
        type="password"
        autoComplete="new-password"
        minLength={10}
        hint="At least 10 characters."
      />
      <button className="sp-btn" type="submit" disabled={busy}>
        {busy ? 'Creating account' : 'Create account'}
      </button>
    </form>
  );
}

export function ForgotPasswordForm() {
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const form = new FormData(e.currentTarget);
    await authClient.requestPasswordReset({
      email: String(form.get('email')),
      redirectTo: '/reset-password',
    });
    setBusy(false);
    // Same answer whether or not the address exists (no account enumeration).
    setStatus({
      kind: 'success',
      text: 'If an account exists for that email, a reset link is on its way.',
    });
  }

  return (
    <form className="sp-form" onSubmit={onSubmit} aria-label="Reset password">
      <Message status={status} />
      <Field id="email" label="Email" type="email" autoComplete="email" />
      <button className="sp-btn" type="submit" disabled={busy}>
        {busy ? 'Sending' : 'Send reset link'}
      </button>
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    const form = new FormData(e.currentTarget);
    const res = await authClient.resetPassword({
      newPassword: String(form.get('password')),
      token,
    });
    setBusy(false);
    if (res.error) {
      setStatus({
        kind: 'error',
        text: 'This reset link is invalid or has expired. Request a new one.',
      });
      return;
    }
    router.push('/login?reset=1');
  }

  return (
    <form className="sp-form" onSubmit={onSubmit} aria-label="Choose a new password">
      <Message status={status} />
      <Field
        id="password"
        label="New password"
        type="password"
        autoComplete="new-password"
        minLength={10}
        hint="At least 10 characters."
      />
      <button className="sp-btn" type="submit" disabled={busy}>
        {busy ? 'Saving' : 'Save new password'}
      </button>
    </form>
  );
}

export function ResendVerificationForm() {
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const form = new FormData(e.currentTarget);
    await authClient.sendVerificationEmail({
      email: String(form.get('email')),
      callbackURL: '/account?verified=1',
    });
    setBusy(false);
    setStatus({
      kind: 'success',
      text: 'If that address has an unverified account, a new link is on its way.',
    });
  }

  return (
    <form className="sp-form" onSubmit={onSubmit} aria-label="Resend verification email">
      <Message status={status} />
      <Field id="email" label="Email" type="email" autoComplete="email" />
      <button className="sp-btn" type="submit" disabled={busy}>
        {busy ? 'Sending' : 'Resend verification email'}
      </button>
    </form>
  );
}

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="sp-btn sp-btn--outline"
      onClick={async () => {
        await authClient.signOut();
        router.push('/');
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
