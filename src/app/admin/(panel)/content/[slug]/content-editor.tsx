'use client';
import * as React from 'react';
import {
  ActionForm,
  Field,
  FormMessage,
  SubmitButton,
  useFormCtx,
  type FormAction,
} from '@/components/admin/forms';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { parseContent } from '@/lib/content-format';

function BodyField({ initial }: { initial: string }) {
  const { state } = useFormCtx();
  const [body, setBody] = React.useState(initial);
  const uid = React.useId();
  const error = state.fieldErrors?.body;
  // After a failed submit React resets the form; put back what the editor typed.
  const submitted = state.values?.body;
  React.useEffect(() => {
    if (submitted !== undefined) setBody(submitted);
  }, [submitted]);
  const blocks = React.useMemo(() => parseContent(body), [body]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${uid}-body`}>Page text</Label>
        <Textarea
          id={`${uid}-body`}
          name="body"
          rows={18}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={50000}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${uid}-help${error ? ` ${uid}-err` : ''}`}
          className="font-mono"
        />
        <p id={`${uid}-help`} className="text-xs text-muted-text">
          Plain text only. A blank line starts a new paragraph. A line starting with{' '}
          <code>## </code> is a heading. Lines starting with <code>- </code> make a bullet list.
          HTML is shown as text, never run.
        </p>
        {error && (
          <p id={`${uid}-err`} className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
      <div>
        <p className="font-mono text-xs uppercase">Live preview</p>
        <div
          className="mt-1 min-h-40 border border-line bg-paper p-4 text-sm"
          role="region"
          aria-label="Preview of the page text"
          aria-live="off"
        >
          {blocks.length === 0 ? (
            <p className="text-muted-text">Nothing to preview yet.</p>
          ) : (
            blocks.map((b, i) =>
              b.type === 'h2' ? (
                <h3 key={i} className="mt-4 mb-1 text-base font-semibold first:mt-0">
                  {b.text}
                </h3>
              ) : b.type === 'p' ? (
                <p key={i} className="mb-3">
                  {b.text}
                </p>
              ) : (
                <ul key={i} className="mb-3 list-disc pl-5">
                  {b.items.map((item, j) => (
                    <li key={j}>{item}</li>
                  ))}
                </ul>
              ),
            )
          )}
        </div>
      </div>
    </div>
  );
}

export function ContentEditor({
  action,
  title,
  body,
  published,
}: {
  action: FormAction;
  title: string;
  body: string;
  published: boolean;
}) {
  return (
    <ActionForm action={action} className="gap-4" aria-label="Edit page">
      <div className="grid gap-3 md:grid-cols-2">
        <Field name="title" label="Title" defaultValue={title} required maxLength={120} />
        <Field
          name="published"
          label="Published (visible in the shop footer links)"
          kind="checkbox"
          defaultValue={published}
          className="self-end pb-2"
        />
      </div>
      <BodyField initial={body} />
      <div className="flex items-center gap-3">
        <SubmitButton>Save page</SubmitButton>
        <FormMessage />
      </div>
    </ActionForm>
  );
}
