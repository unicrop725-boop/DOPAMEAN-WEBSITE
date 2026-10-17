'use client';
import * as React from 'react';
import { Button, type ButtonProps } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  ActionForm,
  FormMessage,
  Hidden,
  SubmitButton,
  useFormCtx,
  type FormAction,
} from './forms';

export const STATUS_EVENT = 'admin:status';

/** Announce a result in the page-wide live region (see StatusRegion). */
export function announce(message: string) {
  window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: message }));
}

/**
 * Runs when an action finishes. A failure (an error message came back) is left on screen so the person can
 * read it and try again. Anything else counts as success: a returned success message is announced, and an
 * action that ended in a redirect (which returns nothing) simply closes the dialog.
 */
function Announce({ done }: { done: () => void }) {
  const { state, pending } = useFormCtx();
  const wasPending = React.useRef(false);
  React.useEffect(() => {
    if (pending) {
      wasPending.current = true;
      return;
    }
    if (!wasPending.current) return;
    wasPending.current = false;
    if (!state.ok && state.message) return;
    if (state.ok && state.message) announce(state.message);
    done();
  }, [pending, state, done]);
  return null;
}

/**
 * A button that opens an alert dialog stating exactly what will happen, then runs a server action.
 * Destructive actions (cancel order, refund, deactivate, delete) must use this. The dialog stays open and
 * shows the error when the action fails; it closes when the action succeeds.
 */
export function ConfirmAction({
  action,
  trigger,
  triggerVariant = 'outline',
  triggerSize = 'sm',
  triggerLabel,
  title,
  description,
  confirmLabel,
  pendingLabel,
  destructive = false,
  hidden,
  children,
}: {
  action: FormAction;
  trigger: React.ReactNode;
  triggerVariant?: ButtonProps['variant'];
  triggerSize?: ButtonProps['size'];
  /** Accessible name when the visible trigger text is not specific enough (e.g. "Deactivate Priya"). */
  triggerLabel?: string;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  pendingLabel?: string;
  destructive?: boolean;
  hidden?: Record<string, string>;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const close = React.useCallback(() => setOpen(false), []);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button type="button" variant={triggerVariant} size={triggerSize} aria-label={triggerLabel}>
          {trigger}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription asChild>
          <div>{description}</div>
        </AlertDialogDescription>
        <ActionForm action={action} className="mt-4">
          <Announce done={close} />
          {hidden && Object.entries(hidden).map(([k, v]) => <Hidden key={k} name={k} value={v} />)}
          {children}
          <FormMessage />
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <AlertDialogCancel asChild>
              <Button type="button" variant="outline">
                Go back
              </Button>
            </AlertDialogCancel>
            <SubmitButton
              variant={destructive ? 'destructive' : 'default'}
              pendingLabel={pendingLabel ?? 'Working'}
            >
              {confirmLabel}
            </SubmitButton>
          </div>
        </ActionForm>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * A single-click action with no confirmation (non-destructive and reversible: move an image, publish).
 * Success is announced in the page status region; failures show next to the button.
 */
export function ActionButton({
  action,
  children,
  variant = 'outline',
  size = 'sm',
  label,
  disabled,
}: {
  action: FormAction;
  children: React.ReactNode;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  /** Accessible name when the visible text is short (e.g. an arrow). */
  label?: string;
  disabled?: boolean;
}) {
  return (
    <ActionForm action={action} className="inline-flex flex-col gap-1">
      <Announce done={() => undefined} />
      <SubmitButton
        variant={variant}
        size={size}
        aria-label={label}
        disabled={disabled}
        pendingLabel="Working"
      >
        {children}
      </SubmitButton>
      <ErrorOnly />
    </ActionForm>
  );
}

function ErrorOnly() {
  const { state, pending } = useFormCtx();
  if (pending || state.ok || !state.message) return <span aria-live="polite" />;
  return (
    <span role="alert" className="max-w-xs text-xs text-danger">
      {state.message}
    </span>
  );
}
