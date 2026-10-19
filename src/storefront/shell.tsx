import Script from 'next/script';
import '@/styles/shop-pages.css';
import { SiteFooter } from './footer';
import { SiteHeader } from './header';

/**
 * Shared frame for storefront screens that have no original design: the original header and footer
 * (ported 1:1) around a content area that follows the original collection layout.
 */
export function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <link rel="stylesheet" href="/css/collection_page.css" precedence="storefront" />
      <link rel="stylesheet" href="/css/collection_page_responsive.css" precedence="storefront" />
      <a className="sp-skip" href="#main">
        Skip to content
      </a>
      <SiteHeader />
      <div className="main-content-area">
        <main id="main" className="sp-page">
          {children}
        </main>
      </div>
      <SiteFooter />
      <Script src="/js/storefront.js" strategy="afterInteractive" />
    </>
  );
}

export function PageTitle({ children }: { children: React.ReactNode }) {
  return <h1 className="sp-title">[ {children} ]</h1>;
}
