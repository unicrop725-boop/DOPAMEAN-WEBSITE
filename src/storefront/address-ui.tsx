'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import {
  deleteAddressAction,
  saveAddressAction,
  setDefaultAddressAction,
  type FormState,
} from '@/app/(storefront)/account/actions';

export type AddressView = {
  id: string;
  fullName: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  pincode: string;
  phone: string;
  isDefault: boolean;
};

export function AddressList({ addresses }: { addresses: AddressView[] }) {
  return (
    <>
      {addresses.length === 0 ? (
        <div className="sp-empty">
          <p className="sp-text" style={{ margin: '0 auto' }}>
            You have no saved addresses.
          </p>
        </div>
      ) : (
        <ul className="sp-list">
          {addresses.map((a) => (
            <li key={a.id}>
              <p className="sp-address-name">
                {a.fullName}
                {a.isDefault && <span className="sp-badge">Default</span>}
              </p>
              <p style={{ margin: 0 }}>
                {a.line1}
                {a.line2 ? `, ${a.line2}` : ''}
                <br />
                {a.city}, {a.state} {a.pincode}
                <br />
                Phone: {a.phone}
              </p>
              <div className="sp-actions" style={{ marginTop: 10 }}>
                <Link className="sp-btn sp-btn--outline" href={`/account/addresses?edit=${a.id}`}>
                  Edit
                </Link>
                {!a.isDefault && (
                  <form action={setDefaultAddressAction}>
                    <input type="hidden" name="id" value={a.id} />
                    <button className="sp-btn sp-btn--outline" type="submit">
                      Make default
                    </button>
                  </form>
                )}
                <form action={deleteAddressAction}>
                  <input type="hidden" name="id" value={a.id} />
                  <button className="sp-btn sp-btn--outline" type="submit">
                    Delete
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="sp-actions" style={{ marginTop: 18 }}>
        <Link className="sp-btn" href="/account/addresses?new=1">
          Add address
        </Link>
      </div>
    </>
  );
}

type Initial = {
  id: string;
  fullName: string;
  line1: string;
  line2: string;
  city: string;
  stateCode: string;
  pincode: string;
  phone: string;
  isDefault: boolean;
};

function TextField(props: {
  name: string;
  label: string;
  defaultValue?: string;
  error?: string;
  autoComplete?: string;
  inputMode?: 'numeric' | 'tel';
  required?: boolean;
}) {
  const errId = `${props.name}-error`;
  return (
    <div className="sp-field">
      <label htmlFor={props.name}>{props.label}</label>
      <input
        id={props.name}
        name={props.name}
        className="sp-input"
        defaultValue={props.defaultValue}
        autoComplete={props.autoComplete}
        inputMode={props.inputMode}
        required={props.required ?? true}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={props.error ? errId : undefined}
      />
      {props.error && (
        <span id={errId} className="sp-field-hint" style={{ color: 'var(--color-danger)' }}>
          {props.error}
        </span>
      )}
    </div>
  );
}

export function AddressForm({
  initial,
  states,
}: {
  initial?: Initial;
  states: readonly { code: string; name: string }[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveAddressAction, {
    ok: false,
  });
  const e = state.fieldErrors ?? {};
  return (
    <form
      className="sp-form sp-narrow"
      action={action}
      aria-label={initial ? 'Edit address' : 'Add address'}
    >
      {state.message && (
        <p role="alert" className="sp-message sp-message--error">
          {state.message}
        </p>
      )}
      {initial && <input type="hidden" name="id" value={initial.id} />}
      <TextField
        name="fullName"
        label="Full name"
        defaultValue={initial?.fullName}
        error={e.fullName}
        autoComplete="name"
      />
      <TextField
        name="line1"
        label="Address line 1"
        defaultValue={initial?.line1}
        error={e.line1}
        autoComplete="address-line1"
      />
      <TextField
        name="line2"
        label="Address line 2 (optional)"
        defaultValue={initial?.line2}
        error={e.line2}
        autoComplete="address-line2"
        required={false}
      />
      <TextField
        name="city"
        label="City"
        defaultValue={initial?.city}
        error={e.city}
        autoComplete="address-level2"
      />
      <div className="sp-field">
        <label htmlFor="stateCode">State</label>
        <select
          id="stateCode"
          name="stateCode"
          className="sp-select"
          defaultValue={initial?.stateCode ?? ''}
          required
          aria-invalid={e.stateCode ? true : undefined}
        >
          <option value="" disabled>
            Choose a state
          </option>
          {states.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
            </option>
          ))}
        </select>
        {e.stateCode && (
          <span className="sp-field-hint" style={{ color: 'var(--color-danger)' }}>
            {e.stateCode}
          </span>
        )}
      </div>
      <TextField
        name="pincode"
        label="Pincode"
        defaultValue={initial?.pincode}
        error={e.pincode}
        autoComplete="postal-code"
        inputMode="numeric"
      />
      <TextField
        name="phone"
        label="Mobile number"
        defaultValue={initial?.phone}
        error={e.phone}
        autoComplete="tel"
        inputMode="tel"
      />
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" name="isDefault" defaultChecked={initial?.isDefault} /> Make this my
        default address
      </label>
      <div className="sp-actions">
        <button className="sp-btn" type="submit" disabled={pending}>
          {pending ? 'Saving' : 'Save address'}
        </button>
        <Link className="sp-btn sp-btn--outline" href="/account/addresses">
          Cancel
        </Link>
      </div>
    </form>
  );
}
