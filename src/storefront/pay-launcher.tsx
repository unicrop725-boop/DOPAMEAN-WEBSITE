'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

type RazorpayResponse = {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
};

type Props = {
  keyId: string;
  providerOrderId: string;
  amountPaise: number;
  orderNumber: number;
  publicId: string;
  token: string | null;
  email: string;
  phone: string;
  name: string;
  totalLabel: string;
};

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => {
      open: () => void;
      on: (e: string, cb: () => void) => void;
    };
  }
}

const SRC = 'https://checkout.razorpay.com/v1/checkout.js';

/**
 * Opens Razorpay's hosted checkout (card data never touches our servers). When it finishes the browser is sent
 * to /checkout/return, which verifies the signature AND asks Razorpay's API before anything is marked paid.
 */
export function PayLauncher(p: Props) {
  const [ready, setReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [failed, setFailed] = useState(false);
  const opened = useRef(false);

  useEffect(() => {
    if (window.Razorpay) {
      setReady(true);
      return;
    }
    const s = document.createElement('script');
    s.src = SRC;
    s.async = true;
    s.onload = () => setReady(true);
    s.onerror = () => setFailed(true);
    document.body.appendChild(s);
    return () => {
      s.onload = null;
      s.onerror = null;
    };
  }, []);

  const open = useCallback(() => {
    if (!window.Razorpay) return;
    setDismissed(false);
    const rz = new window.Razorpay({
      key: p.keyId,
      order_id: p.providerOrderId,
      amount: p.amountPaise,
      currency: 'INR',
      name: 'DOPAMEAN',
      description: `Order #${p.orderNumber}`,
      prefill: { name: p.name, email: p.email, contact: p.phone },
      modal: { ondismiss: () => setDismissed(true) },
      handler: (r: RazorpayResponse) => {
        const q = new URLSearchParams({
          o: p.publicId,
          razorpay_order_id: r.razorpay_order_id,
          razorpay_payment_id: r.razorpay_payment_id,
          razorpay_signature: r.razorpay_signature,
        });
        if (p.token) q.set('t', p.token);
        window.location.href = `/checkout/return?${q.toString()}`;
      },
    });
    rz.on('payment.failed', () => setDismissed(true));
    rz.open();
  }, [p]);

  useEffect(() => {
    if (ready && !opened.current) {
      opened.current = true;
      open();
    }
  }, [ready, open]);

  const orderHref = p.token
    ? `/orders/${p.publicId}?t=${encodeURIComponent(p.token)}`
    : `/account/orders/${p.publicId}`;

  return (
    <div className="sp-box sp-narrow">
      <p className="sp-text">
        Order #{p.orderNumber}: {p.totalLabel}
      </p>
      {failed ? (
        <p role="alert" className="sp-message sp-message--error">
          We could not load the payment window. Check your connection and try again.
        </p>
      ) : !ready ? (
        <p role="status" className="sp-text">
          Opening secure payment...
        </p>
      ) : dismissed ? (
        <p role="status" className="sp-text">
          Payment was not completed. You can try again.
        </p>
      ) : (
        <p role="status" className="sp-text">
          Complete the payment in the secure window.
        </p>
      )}
      <div className="sp-actions">
        <button className="sp-btn" type="button" onClick={open} disabled={!ready}>
          Pay {p.totalLabel}
        </button>
        <Link className="sp-btn sp-btn--outline" href={orderHref}>
          View order
        </Link>
      </div>
    </div>
  );
}
