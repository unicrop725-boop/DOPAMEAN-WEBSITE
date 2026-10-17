import { getDb } from '@/db/client';
import { ActionButton, ConfirmAction } from '@/components/admin/confirm-action';
import { ActionForm, Field, FormMessage, SubmitButton } from '@/components/admin/forms';
import { EmptyState, Forbidden, PageHeader } from '@/components/admin/parts';
import { Badge } from '@/components/ui/badge';
import { listBannersAdmin } from '@/lib/admin/banners';
import { gate } from '@/lib/admin/page';
import { DEFAULT_FAVICON, getFaviconKey } from '@/lib/banners';
import { mediaUrl } from '@/modules/catalog';
import { can } from '@/modules/staff';
import {
  clearFaviconAction,
  deleteBannerAction,
  moveBannerAction,
  updateBannerAction,
} from './actions';
import { ImageUploader } from './image-uploader';

export const metadata = { title: 'Banners and site icon' };
export const dynamic = 'force-dynamic';

export default async function BannersPage() {
  const g = await gate('catalog.edit');
  if (!g.ok) return <Forbidden what="banners" reason={g.reason} />;
  const db = getDb();
  const banners = await listBannersAdmin(db, g.admin);
  const canSetIcon = can(g.admin.role, 'settings.manage');
  const faviconKey = await getFaviconKey(db);
  const sections = [
    {
      id: 'hero-list',
      title: 'Home page slider',
      empty:
        'No slides yet: the home page shows its original single picture. Add a slide and the slider takes over.',
      items: banners.filter((b) => b.placement === 'hero'),
    },
    {
      id: 'promo-list',
      title: 'Home page strip slider (under the free-shipping bar)',
      empty: 'No slides yet: nothing is shown under the free-shipping bar.',
      items: banners.filter((b) => b.placement === 'promo'),
    },
    {
      id: 'shop-list',
      title: 'Shop page slider (top of Shop all and collection pages)',
      empty: 'No slides yet: the shop pages start with the filter bar.',
      items: banners.filter((b) => b.placement === 'shop'),
    },
    {
      id: 'collection-list',
      title: 'Collection page banners',
      empty: 'No banners yet: the collection pages show products only.',
      items: banners.filter(
        (b) => b.placement !== 'hero' && b.placement !== 'promo' && b.placement !== 'shop',
      ),
    },
  ];

  return (
    <section aria-labelledby="page-title" className="flex flex-col gap-8">
      <PageHeader
        title="Banners and site icon"
        description="Slides of the home page sliders, the shop page slider and banners between the product rows of the collection pages. Within each list, the order below is the order shown. Only shown items appear on the shop."
      />

      <div className="grid gap-6 md:grid-cols-2">
        <section aria-labelledby="add-banner" className="border border-line p-4">
          <h2 id="add-banner" className="mb-3 font-mono text-sm uppercase">
            Add a banner
          </h2>
          <ImageUploader
            kind="banner"
            submitLabel="Upload banner"
            hint="JPEG, PNG or WebP, up to 5 MB. Slider pictures work best wide (for example 2400 x 1350); collection banners wider still (2400 x 600). Saved as WebP with camera data removed."
          />
        </section>

        {canSetIcon && (
          <section aria-labelledby="site-icon" className="border border-line p-4">
            <h2 id="site-icon" className="mb-3 font-mono text-sm uppercase">
              Site icon
            </h2>
            <div className="mb-3 flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={faviconKey ? mediaUrl(faviconKey) : DEFAULT_FAVICON}
                alt="Current site icon"
                width={48}
                height={48}
                className="h-12 w-12 border border-line object-contain"
              />
              <p className="text-sm text-muted-text">
                {faviconKey ? 'Custom icon in use.' : 'The built-in icon is in use.'}
              </p>
            </div>
            <ImageUploader
              kind="favicon"
              submitLabel="Upload site icon"
              hint="A square PNG, JPEG or WebP works best. It is shrunk to 256 px and shown in the browser tab."
            />
            {faviconKey && (
              <div className="mt-3">
                <ConfirmAction
                  action={clearFaviconAction}
                  trigger="Use the built-in icon"
                  title="Use the built-in icon?"
                  description="The uploaded icon is deleted and the original icon is shown again."
                  confirmLabel="Use built-in icon"
                  destructive
                />
              </div>
            )}
          </section>
        )}
      </div>

      {sections.map((section) => (
        <section key={section.id} aria-labelledby={section.id}>
          <h2 id={section.id} className="mb-3 font-mono text-sm uppercase">
            {section.title} ({section.items.length})
          </h2>
          {section.items.length === 0 ? (
            <EmptyState title="Nothing here yet">{section.empty}</EmptyState>
          ) : (
            <ol className="flex flex-col gap-4">
              {section.items.map((b, i) => (
                <li key={b.id} className="border border-line p-4">
                  <div className="grid gap-4 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={mediaUrl(b.objectKey)}
                      alt={b.alt}
                      width={b.width}
                      height={b.height}
                      className="w-full border border-line object-contain"
                    />
                    <div className="flex flex-col gap-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs">Position {i + 1}</span>
                        {b.active ? (
                          <Badge tone="success">Shown</Badge>
                        ) : (
                          <Badge tone="muted">Hidden</Badge>
                        )}
                      </div>
                      <ActionForm
                        action={updateBannerAction.bind(null, b.id)}
                        aria-label={`Edit ${section.title} item ${i + 1}`}
                      >
                        <Field
                          name="alt"
                          label="Alt text"
                          defaultValue={b.alt}
                          maxLength={200}
                          required
                        />
                        {b.placement === 'hero' && (
                          <>
                            <Field
                              name="heading"
                              label="Headline"
                              defaultValue={b.heading}
                              maxLength={120}
                            />
                            <Field
                              name="body"
                              label="Short text"
                              defaultValue={b.body}
                              maxLength={300}
                            />
                            <Field
                              name="ctaLabel"
                              label="Button text (needs a link)"
                              defaultValue={b.ctaLabel}
                              maxLength={30}
                            />
                          </>
                        )}
                        <Field
                          name="linkUrl"
                          label="Link (optional)"
                          defaultValue={b.linkUrl}
                          maxLength={500}
                          placeholder="/collections/new-in"
                        />
                        <Field
                          name="active"
                          label="Show on the shop"
                          kind="checkbox"
                          defaultValue={b.active}
                        />
                        <FormMessage />
                        <div>
                          <SubmitButton>Save</SubmitButton>
                        </div>
                      </ActionForm>
                      <div className="flex flex-wrap items-start gap-2">
                        <ActionButton
                          action={moveBannerAction.bind(null, b.id, 'up')}
                          label={`Move ${section.title} item ${i + 1} up`}
                          disabled={i === 0}
                        >
                          Move up
                        </ActionButton>
                        <ActionButton
                          action={moveBannerAction.bind(null, b.id, 'down')}
                          label={`Move ${section.title} item ${i + 1} down`}
                          disabled={i === section.items.length - 1}
                        >
                          Move down
                        </ActionButton>
                        <ConfirmAction
                          action={deleteBannerAction.bind(null, b.id)}
                          trigger="Delete"
                          triggerLabel={`Delete ${section.title} item ${i + 1}`}
                          title="Delete this picture?"
                          description="It is removed from the shop together with its image. This cannot be undone."
                          confirmLabel="Delete"
                          destructive
                        />
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      ))}
    </section>
  );
}
