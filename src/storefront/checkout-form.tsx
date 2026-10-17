'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef, useState } from 'react';
import { placeOrderAction, type PlaceState } from '@/app/(storefront)/checkout/actions';

export type MethodSummary = {
  token: string;
  subtotalLabel: string;
  shippingLabel: string;
  taxLabel: string;
  totalLabel: string;
  /** Why this method cannot be used (limit exceeded, not configured), or null when it can. */
  unavailableReason: string | null;
};

export type SavedAddress = { id: string; text: string; isDefault: boolean };

export type CheckoutLine = {
  name: string;
  option: string;
  qty: number;
  totalLabel: string;
  imageUrl: string | null;
};

type Props = {
  email: string;
  phone: string;
  signedIn: boolean;
  savedAddresses: SavedAddress[];
  states: readonly { code: string; name: string }[];
  defaultState: string;
  lines: CheckoutLine[];
  summaries: { cod: MethodSummary; online: MethodSummary };
  /** Generated on the server so server and client markup agree (no hydration mismatch). */
  initialKey: string;
};

function Field(props: {
  name: string;
  label: string;
  error?: string;
  defaultValue?: string;
  type?: string;
  autoComplete?: string;
  inputMode?: 'numeric' | 'tel';
  required?: boolean;
}) {
  return (
    <div className="sp-field">
      <label htmlFor={props.name}>{props.label}</label>
      <input
        id={props.name}
        name={props.name}
        type={props.type ?? 'text'}
        className="sp-input"
        defaultValue={props.defaultValue}
        autoComplete={props.autoComplete}
        inputMode={props.inputMode}
        required={props.required ?? true}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={props.error ? `${props.name}-err` : undefined}
      />
      {props.error && (
        <span
          id={`${props.name}-err`}
          className="sp-field-hint"
          style={{ color: 'var(--color-danger)' }}
        >
          {props.error}
        </span>
      )}
    </div>
  );
}

export function CheckoutForm(p: Props) {
  const router = useRouter();
  const [state, action, pending] = useActionState<PlaceState, FormData>(placeOrderAction, {
    ok: false,
  });
  const firstAvailable: 'cod' | 'online' = !p.summaries.cod.unavailableReason ? 'cod' : 'online';
  const [method, setMethod] = useState<'cod' | 'online'>(firstAvailable);
  const [addressId, setAddressId] = useState<string>(
    p.savedAddresses.find((a) => a.isDefault)?.id ?? p.savedAddresses[0]?.id ?? '',
  );
  // One key per checkout session: a double click or a retry after a network blip cannot create a second order.
  const keyRef = useRef<string>(p.initialKey);

  // If the order changed under the customer, fetch fresh totals and a fresh signed token (INV-12).
  useEffect(() => {
    if (
      state.code === 'PRICE_CHANGED' ||
      state.code === 'STOCK_CHANGED' ||
      state.code === 'OUT_OF_STOCK'
    ) {
      keyRef.current = crypto.randomUUID().replaceAll('-', '');
      router.refresh();
    }
  }, [state, router]);

  const s = p.summaries[method];
  const e = state.fieldErrors ?? {};
  const v = state.values ?? {};
  const useSaved = p.signedIn && p.savedAddresses.length > 0 && addressId !== '';

  return (
    <form className="sp-checkout" action={action} aria-label="Checkout">
      <div className="sp-form">
        {state.message && (
          <div role="alert" className="sp-message sp-message--error">
            <p style={{ margin: 0 }}>{state.message}</p>
            {state.changes && state.changes.length > 0 && (
              <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                {state.changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            )}
            {state.changes && state.changes.length > 0 && (
              <p style={{ margin: '8px 0 0' }}>
                Review the updated summary and place your order again.
              </p>
            )}
          </div>
        )}

        <input type="hidden" name="idempotencyKey" value={keyRef.current} />
        <input type="hidden" name="quoteTokenCod" value={p.summaries.cod.token} />
        <input type="hidden" name="quoteTokenOnline" value={p.summaries.online.token} />

        <h2 className="sp-subtitle" style={{ marginTop: 0 }}>
          Contact
        </h2>
        <Field
          name="email"
          label="Email"
          type="email"
          defaultValue={v.email ?? p.email}
          autoComplete="email"
          error={e.email}
        />
        <Field
          name="phone"
          label="Mobile number"
          type="tel"
          defaultValue={v.phone ?? p.phone}
          autoComplete="tel"
          inputMode="tel"
          error={e.phone}
        />

        <h2 className="sp-subtitle">Delivery address</h2>
        {p.signedIn && p.savedAddresses.length > 0 && (
          <fieldset className="sp-fieldset">
            <legend>Saved addresses</legend>
            {p.savedAddresses.map((a) => (
              <label key={a.id} className="sp-radio">
                <input
                  type="radio"
                  name="addressId"
                  value={a.id}
                  checked={addressId === a.id}
                  onChange={() => setAddressId(a.id)}
                />
                <span>{a.text}</span>
              </label>
            ))}
            <label className="sp-radio">
              <input
                type="radio"
                name="addressId"
                value=""
                checked={addressId === ''}
                onChange={() => setAddressId('')}
              />
              <span>Use a different address</span>
            </label>
          </fieldset>
        )}
        {!useSaved && (
          <>
            <Field
              name="fullName"
              label="Full name"
              autoComplete="name"
              defaultValue={v.fullName}
              error={e.fullName}
            />
            <Field
              name="line1"
              label="Address line 1"
              autoComplete="address-line1"
              defaultValue={v.line1}
              error={e.line1}
            />
            <Field
              name="line2"
              label="Address line 2 (optional)"
              autoComplete="address-line2"
              required={false}
              defaultValue={v.line2}
              error={e.line2}
            />
            <Field
              name="city"
              label="City"
              autoComplete="address-level2"
              defaultValue={v.city}
              error={e.city}
            />
            <div className="sp-field">
              <label htmlFor="stateCode">State</label>
              <select
                id="stateCode"
                name="stateCode"
                className="sp-select"
                defaultValue={v.stateCode ?? p.defaultState}
                required
                aria-invalid={e.stateCode ? true : undefined}
              >
                {p.states.map((st) => (
                  <option key={st.code} value={st.code}>
                    {st.name}
                  </option>
                ))}
              </select>
              {e.stateCode && (
                <span className="sp-field-hint" style={{ color: 'var(--color-danger)' }}>
                  {e.stateCode}
                </span>
              )}
            </div>
            <Field
              name="pincode"
              label="Pincode"
              autoComplete="postal-code"
              defaultValue={v.pincode}
              inputMode="numeric"
              error={e.pincode}
            />
            <Field
              name="addressPhone"
              label="Phone for the courier"
              defaultValue={v.addressPhone}
              type="tel"
              autoComplete="tel"
              inputMode="tel"
              error={e.phone}
            />
          </>
        )}

        <h2 className="sp-subtitle">Payment</h2>
        <fieldset className="sp-fieldset">
          <legend className="sp-skip">Payment method</legend>
          {(['cod', 'online'] as const).map((m) => {
            const reason = p.summaries[m].unavailableReason;
            return (
              <label key={m} className="sp-radio" aria-disabled={reason ? true : undefined}>
                <input
                  type="radio"
                  name="paymentMethod"
                  value={m}
                  checked={method === m}
                  disabled={!!reason}
                  onChange={() => setMethod(m)}
                />
                <span>
                  {m === 'cod' ? 'Cash on delivery' : 'Pay online (UPI, cards, netbanking)'}
                  {reason && (
                    <span className="sp-field-hint" style={{ display: 'block' }}>
                      {reason}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </fieldset>
      </div>

      <aside className="sp-box" aria-label="Order summary">
        <h2 className="sp-subtitle" style={{ marginTop: 0, borderTop: 0, paddingTop: 0 }}>
          Your order
        </h2>
        <ul className="sp-list" style={{ marginBottom: 12 }}>
          {p.lines.map((l, i) => (
            <li key={`${l.name}-${l.option}-${i}`} style={{ padding: '8px 10px' }}>
              <span className="sp-address-name" style={{ display: 'block' }}>
                {l.name}
              </span>
              {l.option.toUpperCase()} x {l.qty}{' '}
              <span style={{ float: 'right' }}>{l.totalLabel}</span>
            </li>
          ))}
        </ul>
        <dl className="sp-summary">
          <div>
            <dt>Subtotal</dt>
            <dd>{s.subtotalLabel}</dd>
          </div>
          <div>
            <dt>Shipping</dt>
            <dd>{s.shippingLabel}</dd>
          </div>
          <div className="sp-summary-total">
            <dt>Total</dt>
            <dd>{s.totalLabel}</dd>
          </div>
        </dl>
        <p className="sp-field-hint">Prices include GST ({s.taxLabel}).</p>
        <div
          className="sp-actions"
          style={{ flexDirection: 'column', alignItems: 'stretch', marginTop: 12 }}
        >
          <button className="sp-btn" type="submit" disabled={pending || !!s.unavailableReason}>
            {pending ? 'Placing order' : method === 'cod' ? 'Place order' : 'Continue to payment'}
          </button>
          <Link className="sp-btn sp-btn--outline" href="/cart">
            Back to bag
          </Link>
        </div>
      </aside>
    </form>
  );
}
