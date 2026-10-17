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
 * Upload form for product images. Client-side checks are only a convenience (instant feedback): the server
 * sniffs the real bytes, enforces the 5 MB limit, rejects SVG and re-encodes every image.
 */
export function MediaUploader({ productId }: { productId: string }) {
  const router = useRouter();
  const formRef = React.useRef<HTMLFormElement>(null);
  const [status, setStatus] = React.useState<Status>({ kind: 'idle' });
  const uid = React.useId();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
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
    data.set('productId', productId);
    setStatus({ kind: 'busy' });
    try {
      const res = await fetch('/admin/api/media', { method: 'POST', body: data });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        message?: string;
      } | null;
      if (!res.ok || !body?.ok) {
        setStatus({
          kind: 'error',
          message: body?.message ?? 'The upload failed. Nothing was saved.',
        });
        return;
      }
      formRef.current?.reset();
      setStatus({ kind: 'ok', message: 'Image uploaded.' });
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
      aria-label="Upload an image"
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
          JPEG, PNG or WebP, up to 5 MB. Saved as WebP, at most 2400 px, with camera data removed.
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${uid}-alt`}>Alt text (describe the image)</Label>
        <Input id={`${uid}-alt`} name="alt" maxLength={200} autoComplete="off" />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status.kind === 'busy'}>
          {status.kind === 'busy' ? 'Uploading…' : 'Upload image'}
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
