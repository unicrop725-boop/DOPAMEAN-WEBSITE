'use client';

import { useActionState } from 'react';
import { deleteAccountAction, type FormState } from '@/app/(storefront)/account/actions';

export function DeleteAccountForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(deleteAccountAction, {
    ok: false,
  });
  return (
    <form className="sp-form sp-narrow" action={action} aria-label="Delete account">
      {state.message && (
        <p role="alert" className="sp-message sp-message--error">
          {state.message}
        </p>
      )}
      <div className="sp-field">
        <label htmlFor="password">Your password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          className="sp-input"
          required
        />
      </div>
      <div className="sp-field">
        <label htmlFor="confirm">Type DELETE to confirm</label>
        <input id="confirm" name="confirm" autoComplete="off" className="sp-input" required />
      </div>
      <div className="sp-actions">
        <button className="sp-btn sp-btn--danger" type="submit" disabled={pending}>
          {pending ? 'Deleting' : 'Delete my account'}
        </button>
      </div>
    </form>
  );
}
