'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { StorefrontBanner } from '@/lib/banners';

const INTERVAL_MS = 6000;

/**
 * The home page hero as a slider. Each slide is a full-bleed picture with the original text block on top
 * (headline, short text, button). It advances by itself every few seconds, stops while the visitor hovers or
 * focuses it, can be moved with the arrows, the dots, the arrow keys or a swipe, and does not move by itself
 * for visitors who ask for reduced motion.
 */
export function HeroSlider({
  slides,
  showText = true,
  inline = false,
  label = 'Featured',
}: {
  slides: StorefrontBanner[];
  /** The mobile hero shows pictures only, like the original mobile layout. */
  showText?: boolean;
  /** Sits in the page flow with its own height (the strip under the free-shipping bar) instead of filling its parent. */
  inline?: boolean;
  label?: string;
}) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const touchX = useRef<number | null>(null);
  const count = slides.length;

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const go = useCallback((n: number) => setIndex(((n % count) + count) % count), [count]);

  useEffect(() => {
    if (count < 2 || paused || reduced) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % count), INTERVAL_MS);
    return () => clearInterval(t);
  }, [count, paused, reduced]);

  return (
    <div
      className={`hero-slider${inline ? ' hero-slider--inline' : ''}`}
      role="region"
      aria-roledescription="carousel"
      aria-label={label}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') go(index - 1);
        if (e.key === 'ArrowRight') go(index + 1);
      }}
      onTouchStart={(e) => {
        touchX.current = e.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(e) => {
        const start = touchX.current;
        touchX.current = null;
        const end = e.changedTouches[0]?.clientX;
        if (start === null || end === undefined || Math.abs(end - start) < 40) return;
        go(index + (end < start ? 1 : -1));
      }}
    >
      {slides.map((s, i) => {
        const active = i === index;
        return (
          <div
            key={s.id}
            className={`hero-slide${active ? ' is-active' : ''}`}
            role="group"
            aria-roledescription="slide"
            aria-label={`${i + 1} of ${count}`}
            aria-hidden={active ? undefined : true}
          >
            <img
              className="hero-slide-img"
              src={s.imageUrl}
              alt={s.alt}
              width={s.width}
              height={s.height}
              loading={i === 0 ? 'eager' : 'lazy'}
            />
            {showText && (s.heading || s.body || (s.ctaLabel && s.linkUrl)) && (
              <div className="banner-text-content">
                {s.heading && <div className="banner-headline">{s.heading}</div>}
                {s.body && <div className="banner-subheadline">{s.body}</div>}
                {s.ctaLabel && s.linkUrl && (
                  <div className="banner-cta-link">
                    <a href={s.linkUrl} tabIndex={active ? 0 : -1}>
                      {s.ctaLabel}
                    </a>
                  </div>
                )}
              </div>
            )}
            {!showText && s.linkUrl && (
              <a
                className="hero-slide-link"
                href={s.linkUrl}
                aria-label={s.alt}
                tabIndex={active ? 0 : -1}
              />
            )}
          </div>
        );
      })}
      {count > 1 && (
        <>
          <button
            type="button"
            className="hero-arrow hero-arrow--prev"
            aria-label="Previous slide"
            onClick={() => go(index - 1)}
          >
            &lt;
          </button>
          <button
            type="button"
            className="hero-arrow hero-arrow--next"
            aria-label="Next slide"
            onClick={() => go(index + 1)}
          >
            &gt;
          </button>
          <div className="hero-dots">
            {slides.map((s, i) => (
              <button
                key={s.id}
                type="button"
                className={`hero-dot${i === index ? ' is-active' : ''}`}
                aria-label={`Show slide ${i + 1}`}
                aria-current={i === index ? 'true' : undefined}
                onClick={() => go(i)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
