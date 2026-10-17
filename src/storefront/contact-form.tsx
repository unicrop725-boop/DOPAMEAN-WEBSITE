'use client';

import { useActionState } from 'react';
import { sendContactAction, type ContactState } from '@/app/(storefront)/pages/[slug]/actions';

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <span id={id} className="sp-field-hint" style={{ color: 'var(--color-danger)' }}>
      {message}
    </span>
  );
}

/** Contact form: name, then email and subject side by side, then the message and a full-width send button. */
export function ContactForm() {
  const [state, action, pending] = useActionState<ContactState, FormData>(sendContactAction, {
    ok: false,
  });
  const e = state.fieldErrors ?? {};
  const v = state.values ?? {};

  if (state.ok) {
    return (
      <p role="status" className="sp-message sp-message--success">
        {state.message ?? 'Thank you. Your message has been sent.'}
      </p>
    );
  }

  return (
    <form className="sp-form sp-contact-form" action={action} aria-label="Contact us">
      {state.message && (
        <p role="alert" className="sp-message sp-message--error">
          {state.message}
        </p>
      )}
      <div className="sp-field">
        <label htmlFor="name">Name*</label>
        <input
          id="name"
          name="name"
          className="sp-input"
          autoComplete="name"
          defaultValue={v.name}
          required
          aria-invalid={e.name ? true : undefined}
          aria-describedby={e.name ? 'name-err' : undefined}
        />
        <FieldError id="name-err" message={e.name} />
      </div>
      <div className="sp-contact-row">
        <div className="sp-field">
          <label htmlFor="email">Email*</label>
          <input
            id="email"
            name="email"
            type="email"
            className="sp-input"
            autoComplete="email"
            defaultValue={v.email}
            required
            aria-invalid={e.email ? true : undefined}
            aria-describedby={e.email ? 'email-err' : undefined}
          />
          <FieldError id="email-err" message={e.email} />
        </div>
        <div className="sp-field">
          <label htmlFor="subject">Subject</label>
          <input
            id="subject"
            name="subject"
            className="sp-input"
            autoComplete="off"
            maxLength={150}
            defaultValue={v.subject}
            aria-invalid={e.subject ? true : undefined}
            aria-describedby={e.subject ? 'subject-err' : undefined}
          />
          <FieldError id="subject-err" message={e.subject} />
        </div>
      </div>
      <div className="sp-field">
        <label htmlFor="message">Your message*</label>
        <textarea
          id="message"
          name="message"
          className="sp-input sp-contact-message"
          placeholder="Write your question or feedback here"
          required
          minLength={10}
          maxLength={2000}
          defaultValue={v.message}
          aria-invalid={e.message ? true : undefined}
          aria-describedby={e.message ? 'message-err' : undefined}
        />
        <FieldError id="message-err" message={e.message} />
      </div>
      {/* Honeypot: hidden from people, tempting to bots. */}
      <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px' }}>
        <label htmlFor="website">Website</label>
        <input id="website" name="website" tabIndex={-1} autoComplete="off" />
      </div>
      <button className="sp-btn sp-contact-send" type="submit" disabled={pending}>
        {pending ? 'Sending' : 'Send message'}
      </button>
    </form>
  );
}
