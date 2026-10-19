'use client';

import { useActionState } from 'react';
import { sendContactAction, type ContactState } from '@/app/(storefront)/pages/[slug]/actions';

export function ContactForm() {
  const [state, action, pending] = useActionState<ContactState, FormData>(sendContactAction, {
    ok: false,
  });
  const e = state.fieldErrors ?? {};

  if (state.ok) {
    return (
      <p role="status" className="sp-message sp-message--success">
        {state.message ?? 'Thank you. Your message has been sent.'}
      </p>
    );
  }

  return (
    <form
      className="sp-form sp-narrow"
      action={action}
      aria-label="Contact us"
      style={{ marginTop: 24 }}
    >
      {state.message && (
        <p role="alert" className="sp-message sp-message--error">
          {state.message}
        </p>
      )}
      <div className="sp-field">
        <label htmlFor="name">Name</label>
        <input
          id="name"
          name="name"
          className="sp-input"
          autoComplete="name"
          required
          aria-invalid={e.name ? true : undefined}
        />
        {e.name && (
          <span className="sp-field-hint" style={{ color: 'var(--color-danger)' }}>
            {e.name}
          </span>
        )}
      </div>
      <div className="sp-field">
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          className="sp-input"
          autoComplete="email"
          required
          aria-invalid={e.email ? true : undefined}
        />
        {e.email && (
          <span className="sp-field-hint" style={{ color: 'var(--color-danger)' }}>
            {e.email}
          </span>
        )}
      </div>
      <div className="sp-field">
        <label htmlFor="message">Message</label>
        <textarea
          id="message"
          name="message"
          className="sp-input"
          style={{ height: 140, padding: 10 }}
          required
          minLength={10}
          maxLength={2000}
          aria-invalid={e.message ? true : undefined}
        />
        {e.message && (
          <span className="sp-field-hint" style={{ color: 'var(--color-danger)' }}>
            {e.message}
          </span>
        )}
      </div>
      {/* Honeypot: hidden from people, tempting to bots. */}
      <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px' }}>
        <label htmlFor="website">Website</label>
        <input id="website" name="website" tabIndex={-1} autoComplete="off" />
      </div>
      <button className="sp-btn" type="submit" disabled={pending}>
        {pending ? 'Sending' : 'Send message'}
      </button>
    </form>
  );
}
