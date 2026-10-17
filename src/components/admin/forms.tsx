'use client';
import * as React from 'react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/cn';
import type { ActionState } from '@/lib/action-result';

/** What a server action looks like to `useActionState`. */
export type FormAction = (prev: ActionState, form: FormData) => Promise<ActionState>;

const INITIAL: ActionState = { ok: false };

type FormCtx = { state: ActionState; pending: boolean };
export const FormContext = React.createContext<FormCtx>({ state: INITIAL, pending: false });
export const useFormCtx = () => React.useContext(FormContext);

/**
 * A form wired to a server action. Fields (`Field`) and the submit button read its state from context, so
 * pages stay server components and only pass plain data. Failed submits keep what the user typed.
 */
export function ActionForm({
  action,
  children,
  className,
  'aria-label': ariaLabel,
  onSuccess,
}: {
  action: FormAction;
  children: React.ReactNode;
  className?: string;
  'aria-label'?: string;
  onSuccess?: () => void;
}) {
  const [state, formAction, pending] = React.useActionState(action, INITIAL);
  const ok = state.ok;
  React.useEffect(() => {
    if (ok) onSuccess?.();
  }, [ok, state, onSuccess]);
  return (
    <FormContext.Provider value={{ state, pending }}>
      <form
        action={formAction}
        className={cn('flex flex-col gap-3', className)}
        aria-label={ariaLabel}
      >
        {children}
      </form>
    </FormContext.Provider>
  );
}

type Option = { value: string; label: string };

export type FieldProps = {
  name: string;
  label: string;
  hint?: string;
  kind?: 'input' | 'textarea' | 'select' | 'checkbox';
  type?: string;
  defaultValue?: string | number | boolean | null;
  options?: Option[];
  required?: boolean;
  placeholder?: string;
  rows?: number;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  maxLength?: number;
  minLength?: number;
  autoComplete?: string;
  step?: string;
  min?: string | number;
  max?: string | number;
  pattern?: string;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  /** Visually hide the label (it stays for screen readers), for compact table-row forms. */
  hideLabel?: boolean;
};

/** Label + control + hint + field error, wired with aria-describedby and aria-invalid. */
export function Field(props: FieldProps) {
  const { state } = useFormCtx();
  const uid = React.useId();
  const id = `${uid}-${props.name}`;
  const error = state.fieldErrors?.[props.name];
  const submitted = state.values?.[props.name];
  const describedBy = [props.hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');
  const common = {
    id,
    name: props.name,
    required: props.required,
    disabled: props.disabled,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy || undefined,
  } as const;
  const base =
    props.defaultValue === null || props.defaultValue === undefined
      ? ''
      : String(props.defaultValue);
  const value = submitted ?? base;
  // Changing the key re-mounts the control with the retained text after a failed submit.
  const key = submitted === undefined ? 'initial' : `retained-${submitted}`;

  let control: React.ReactNode;
  if (props.kind === 'textarea') {
    control = (
      <Textarea
        key={key}
        {...common}
        rows={props.rows ?? 4}
        defaultValue={value}
        placeholder={props.placeholder}
        maxLength={props.maxLength}
        className={cn(error && 'border-danger', props.inputClassName)}
      />
    );
  } else if (props.kind === 'select') {
    control = (
      <Select
        key={key}
        {...common}
        defaultValue={value}
        className={cn(error && 'border-danger', props.inputClassName)}
      >
        {props.options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    );
  } else if (props.kind === 'checkbox') {
    // After a failed submit an unchecked box is simply absent from the submitted values.
    const checked = state.values ? submitted === 'on' : props.defaultValue === true;
    return (
      <div className={cn('flex flex-col gap-1', props.className)}>
        <div className="flex items-center gap-2">
          <input
            key={state.values ? `retained-${submitted ?? 'off'}` : 'initial'}
            {...common}
            type="checkbox"
            defaultChecked={checked}
            className="size-5 accent-ink"
          />
          <Label htmlFor={id} className="normal-case tracking-normal">
            {props.label}
          </Label>
        </div>
        {props.hint && (
          <p id={`${id}-hint`} className="text-xs text-muted-text">
            {props.hint}
          </p>
        )}
        {error && (
          <p id={`${id}-error`} className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    );
  } else {
    control = (
      <Input
        key={key}
        {...common}
        type={props.type ?? 'text'}
        defaultValue={value}
        placeholder={props.placeholder}
        inputMode={props.inputMode}
        maxLength={props.maxLength}
        minLength={props.minLength}
        autoComplete={props.autoComplete}
        step={props.step}
        min={props.min}
        max={props.max}
        pattern={props.pattern}
        className={cn(error && 'border-danger', props.inputClassName)}
      />
    );
  }

  return (
    <div className={cn('flex flex-col gap-1', props.className)}>
      <Label htmlFor={id} className={cn(props.hideLabel && 'sr-only')}>
        {props.label}
        {props.required && <span aria-hidden="true"> *</span>}
      </Label>
      {control}
      {props.hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-text">
          {props.hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** Submit button that disables itself and says so while the action runs. */
export function SubmitButton({
  children,
  pendingLabel = 'Saving',
  ...props
}: Omit<ButtonProps, 'type'> & { pendingLabel?: string }) {
  const { pending } = useFormCtx();
  return (
    <Button type="submit" disabled={pending || props.disabled} {...props}>
      {pending ? `${pendingLabel}…` : children}
    </Button>
  );
}

/** Result of the last submit: errors are announced at once (role=alert), success politely (role=status). */
export function FormMessage({ className }: { className?: string }) {
  const { state, pending } = useFormCtx();
  return (
    <div className={className} aria-live="polite">
      {!pending && state.message && state.ok && (
        <p role="status" className="text-sm text-success-text">
          {state.message}
        </p>
      )}
      {!pending && state.message && !state.ok && (
        <p role="alert" className="border border-danger bg-danger-bg p-2 text-sm text-danger">
          {state.message}
        </p>
      )}
    </div>
  );
}

/** Hidden field for ids a server action needs. */
export function Hidden({ name, value }: { name: string; value: string }) {
  return <input type="hidden" name={name} value={value} />;
}
