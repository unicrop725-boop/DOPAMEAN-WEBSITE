'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

type Status =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'ok'; message: string }
  | { kind: 'error'; message: string };

/**
 * Upload form for banners and the site icon. Client-side checks are only instant feedback: the server
 * sniffs the real bytes, enforces the 5 MB limit, rejects SVG and re-encodes every image.
 */
export function ImageUploader({
  kind,
  submitLabel,
  hint,
}: {
  kind: 'banner' | 'favicon';
  submitLabel: string;
  hint: string;
}) {
  const router = useRouter();
  const formRef = React.useRef<HTMLFormElement>(null);
  const [status, setStatus] = React.useState<Status>({ kind: 'idle' });
  const uid = React.useId();
  const [placement, setPlacement] = React.useState<'collection' | 'hero' | 'promo' | 'shop'>(
    'hero',
  );

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const file = data.get('file');
    if (!(file instanceof File) || file.size === 0) {
      setStatus({ kind: 'error', message: 'Choose an image file first.' });
      return;
    }
    if (file.size > MAX_BYTES) {
      setStatus({ kind: 'error', message: 'That image is larger than 5 MB.' });
      return;
    }
    if (file.type && !TYPES.includes(file.type)) {
      setStatus({ kind: 'error', message: 'Only JPEG, PNG and WebP images are accepted.' });
      return;
    }
    data.set('kind', kind);
    setStatus({ kind: 'busy' });
    try {
      const res = await fetch('/admin/api/banners', { method: 'POST', body: data });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        message?: string;
        fieldErrors?: Record<string, string>;
      } | null;
      if (!res.ok || !body?.ok) {
        const fieldMessage = body?.fieldErrors ? Object.values(body.fieldErrors)[0] : undefined;
        setStatus({
          kind: 'error',
          message: fieldMessage ?? body?.message ?? 'The upload failed. Nothing was saved.',
        });
        return;
      }
      formRef.current?.reset();
      setStatus({ kind: 'ok', message: body.message ?? 'Uploaded.' });
      router.refresh();
    } catch {
      setStatus({ kind: 'error', message: 'Could not reach the server. Nothing was saved.' });
    }
  }

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      className="flex flex-col gap-3"
      aria-label={kind === 'banner' ? 'Upload a banner' : 'Upload the site icon'}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${uid}-file`}>Image file</Label>
        <Input
          id={`${uid}-file`}
          name="file"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          required
          aria-describedby={`${uid}-hint`}
        />
        <p id={`${uid}-hint`} className="text-xs text-muted-text">
          {hint}
        </p>
      </div>
      {kind === 'banner' && (
        <>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${uid}-placement`}>Where to show it</Label>
            <select
              id={`${uid}-placement`}
              name="placement"
              value={placement}
              onChange={(e) =>
                setPlacement(e.target.value as 'collection' | 'hero' | 'promo' | 'shop')
              }
              className="h-10 border border-line bg-paper px-2 text-sm"
            >
              <option value="hero">Home page slider (big picture at the top)</option>
              <option value="promo">Home page strip slider (under the free-shipping bar)</option>
              <option value="shop">Shop page slider (top of Shop all and collection pages)</option>
              <option value="collection">Collection pages (between rows of products)</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${uid}-alt`}>Alt text (describe the image)</Label>
            <Input id={`${uid}-alt`} name="alt" maxLength={200} autoComplete="off" required />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${uid}-link`}>Link (optional)</Label>
            <Input
              id={`${uid}-link`}
              name="linkUrl"
              maxLength={500}
              autoComplete="off"
              placeholder="/collections/new-in"
            />
          </div>
          {placement === 'hero' && (
            <>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${uid}-heading`}>Headline (optional)</Label>
                <Input id={`${uid}-heading`} name="heading" maxLength={120} autoComplete="off" />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${uid}-body`}>Short text (optional)</Label>
                <Input id={`${uid}-body`} name="body" maxLength={300} autoComplete="off" />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${uid}-cta`}>Button text (optional, needs a link)</Label>
                <Input
                  id={`${uid}-cta`}
                  name="ctaLabel"
                  maxLength={30}
                  autoComplete="off"
                  placeholder="SHOP NOW"
                />
              </div>
            </>
          )}
        </>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status.kind === 'busy'}>
          {status.kind === 'busy' ? 'Uploading…' : submitLabel}
        </Button>
        <div aria-live="polite">
          {status.kind === 'ok' && (
            <p role="status" className="text-sm text-success-text">
              {status.message}
            </p>
          )}
          {status.kind === 'error' && (
            <p role="alert" className="text-sm text-danger">
              {status.message}
            </p>
          )}
        </div>
      </div>
    </form>
  );
}
