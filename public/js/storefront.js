/*
 * Storefront behaviour, ported from the original script/script.js.
 * Same behaviours, but every block is guarded so a page that lacks an element no longer throws and
 * takes the rest of the script down with it, and each control has exactly one handler (the original
 * registered three click handlers on the product-page accordion, which fought each other).
 * Plain DOM script on purpose: the original pages are static markup (ADR 0001 / 0004).
 */
(function () {
  'use strict';

  var isDesktop = window.innerWidth >= 1024;

  function pad(n) {
    return String(n).padStart(2, '0');
  }
  function hms(d) {
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  // ---- Clocks -------------------------------------------------------------------------------
  function tickClocks() {
    var now = new Date();
    var mobile = document.getElementById('mobile-time');
    var desktop = document.getElementById('desktop-time');
    var side = document.getElementById('time1');
    if (mobile) mobile.textContent = hms(now);
    if (desktop) desktop.textContent = '[ INDIA ' + hms(now) + ' HH ]';
    if (side && isDesktop) {
      side.textContent = '[INDIA ' + now.toLocaleTimeString('en-US', { hour12: false }) + ']';
    }
  }
  if (
    document.getElementById('mobile-time') ||
    document.getElementById('desktop-time') ||
    document.getElementById('time1')
  ) {
    tickClocks();
    setInterval(tickClocks, 1000);
  }

  // ---- Mobile footer accordion (.dpm-accordion-*) ---------------------------------------------
  var dpmItems = document.querySelectorAll('.dpm-accordion-item');
  var animOpts = { duration: 400, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' };

  function toggleDpm(item) {
    var content = item.querySelector('.dpm-accordion-content');
    if (!content) return;
    var isOpen = item.classList.contains('is-open');
    item.dataset.animating = 'true';
    var frames = isOpen
      ? [
          { height: content.scrollHeight + 'px', opacity: 1 },
          { height: '0px', opacity: 0 },
        ]
      : [
          { height: '0px', opacity: 0 },
          { height: content.scrollHeight + 'px', opacity: 1 },
        ];
    var anim = content.animate(frames, animOpts);
    item.classList.toggle('is-open');
    anim.onfinish = function () {
      if (item.classList.contains('is-open')) content.style.height = 'auto';
      delete item.dataset.animating;
    };
  }

  dpmItems.forEach(function (item) {
    var header = item.querySelector('.dpm-accordion-header');
    var content = item.querySelector('.dpm-accordion-content');
    if (!header || !content) return;
    if (item.classList.contains('is-open')) {
      content.style.height = 'auto';
    } else {
      content.style.height = '0px';
      content.style.opacity = '0';
      content.style.overflow = 'hidden';
    }
    header.addEventListener('click', function () {
      if (item.dataset.animating) return;
      dpmItems.forEach(function (other) {
        if (other !== item && other.classList.contains('is-open')) toggleDpm(other);
      });
      toggleDpm(item);
    });
  });

  // ---- Product page accordion (.accordion-item) -----------------------------------------------
  var accItems = document.querySelectorAll('.accordion-item');
  accItems.forEach(function (item) {
    var header = item.querySelector('.accordion-header');
    var content = item.querySelector('.accordion-content');
    var icon = header && header.querySelector('.icon');
    if (!header || !content) return;
    header.addEventListener('click', function () {
      var willOpen = !item.classList.contains('active');
      if (isDesktop) {
        // Desktop shows one section at a time.
        accItems.forEach(function (other) {
          if (other === item) return;
          var oc = other.querySelector('.accordion-content');
          var oi = other.querySelector('.accordion-header .icon');
          other.classList.remove('active');
          if (oc) oc.style.maxHeight = '0px';
          if (oi) oi.textContent = '+';
          var oh = other.querySelector('.accordion-header');
          if (oh) oh.setAttribute('aria-expanded', 'false');
        });
      }
      item.classList.toggle('active', willOpen);
      content.style.maxHeight = willOpen ? content.scrollHeight + 'px' : '0px';
      if (icon) icon.textContent = willOpen ? '-' : '+';
      header.setAttribute('aria-expanded', String(willOpen));
    });
  });

  // ---- Size selection ----------------------------------------------------------------------
  // Choosing a size also updates the displayed price (variants may be priced differently).
  function applyVariant(button) {
    var bracket = button.getAttribute('data-price');
    var plain = button.getAttribute('data-price-plain');
    document.querySelectorAll('.add-to-bag-btn-price, .final-price').forEach(function (el) {
      if (bracket) el.textContent = bracket;
    });
    document.querySelectorAll('.product-header .price').forEach(function (el) {
      if (plain) el.textContent = plain;
    });
  }
  // The desktop (.size-selector) and mobile (.size-btn) pickers are two views of one choice: picking a
  // size in either marks the same variant in both, so "add to bag" always uses what the shopper chose.
  var selectorButtons = document.querySelectorAll('.size-selector button');
  var sizeBtns = document.querySelectorAll('.size-btn');
  function chooseVariant(button) {
    var id = button.getAttribute('data-variant-id');
    selectorButtons.forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-variant-id') === id);
    });
    sizeBtns.forEach(function (b) {
      b.classList.toggle('selected', b.getAttribute('data-variant-id') === id);
    });
    applyVariant(button);
  }
  selectorButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      if (!button.disabled) chooseVariant(button);
    });
  });
  sizeBtns.forEach(function (button) {
    button.addEventListener('click', function () {
      if (!button.disabled) chooseVariant(button);
    });
  });

  // ---- Product page: mobile detail tabs (MATERIALS / SHIPPING & RETURNS / CARE GUIDE) ---------
  var tabButtons = document.querySelectorAll('.details-tabs button[data-tab]');
  tabButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var name = btn.getAttribute('data-tab');
      tabButtons.forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      document.querySelectorAll('[data-tab-panel]').forEach(function (panel) {
        panel.hidden = panel.getAttribute('data-tab-panel') !== name;
      });
    });
  });

  // ---- Size guide modal (closes on scroll, like the original) -------------------------------
  var modal = document.getElementById('size-guide-modal');
  if (modal) {
    var closeOnScroll = function () {
      closeModal();
    };
    var openModal = function (e) {
      e.preventDefault();
      modal.classList.add('visible');
      window.addEventListener('scroll', closeOnScroll);
    };
    var closeModal = function () {
      modal.classList.remove('visible');
      window.removeEventListener('scroll', closeOnScroll);
    };
    var openers = [
      document.getElementById('size-guide-link'),
      document.querySelector('.size-guide-link-mobile'),
    ];
    openers.forEach(function (el) {
      if (el) el.addEventListener('click', openModal);
    });
    var closeBtn = document.getElementById('modal-close-button');
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', function (e) {
      if (e.target === modal) closeModal();
    });
  }

  // ---- Product page: sticky dock on mobile -------------------------------------------------
  var container = document.getElementById('component-container');
  var dock = document.getElementById('product-dock');
  if (!isDesktop && container && dock && 'IntersectionObserver' in window) {
    new IntersectionObserver(
      function (entries) {
        var entry = entries[0];
        if (!entry.isIntersecting && entry.boundingClientRect.top > 0)
          container.classList.remove('is-docked');
        else container.classList.add('is-docked');
      },
      { rootMargin: '0px', threshold: 0 },
    ).observe(dock);
  }

  // ---- Product page: desktop thumbnail gallery ---------------------------------------------
  if (isDesktop) {
    var thumbs = document.querySelectorAll('.thumbnail-gallery img');
    var cards = document.querySelectorAll('.product-image-card');
    var scroller = document.querySelector('.product-image-scroller');
    thumbs.forEach(function (thumb, i) {
      thumb.addEventListener('click', function () {
        if (!cards[i] || !scroller) return;
        // Move only the picture strip, sideways. (scrollIntoView would also scroll the whole page up or down,
        // which made the picture jump to the top of the window.)
        var left =
          scroller.scrollLeft +
          cards[i].getBoundingClientRect().left -
          scroller.getBoundingClientRect().left;
        scroller.scrollTo({ left: left, behavior: 'smooth' });
      });
    });
  }

  // ---- Site chrome: search, header buttons, mobile menu, dark mode ----------------------------
  // These wire controls that existed in the original design but did nothing. Look is unchanged until used.
  function go(url) {
    window.location.href = url;
  }
  function makeLink(el, label, handler) {
    if (!el) return;
    el.setAttribute('role', 'link');
    el.setAttribute('tabindex', '0');
    if (label) el.setAttribute('aria-label', label);
    el.style.cursor = 'pointer';
    el.addEventListener('click', handler);
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handler(e);
      }
    });
  }

  makeLink(document.querySelector('.nav-box-header-1'), 'Search', function () {
    go('/search');
  });
  makeLink(document.querySelector('.search-container span'), 'Search', function () {
    go('/search');
  });
  var b1 = document.querySelector('.header-btn-1');
  var b2 = document.querySelector('.header-btn-2');
  var b3 = document.querySelector('.header-btn-3');
  if (b1)
    b1.addEventListener('click', function () {
      go('/collections/all');
    });
  if (b2)
    b2.addEventListener('click', function () {
      go('/pages/contact');
    });

  // Dark mode: inverts the page and counter-inverts media so photos keep their colours. Remembered per browser.
  var THEME_KEY = 'dpm-theme';
  var style = document.createElement('style');
  style.textContent =
    'html.dpm-dark{filter:invert(1) hue-rotate(180deg);background:#000}' +
    'html.dpm-dark img,html.dpm-dark video,html.dpm-dark .mobile-image,html.dpm-dark .product-image{filter:invert(1) hue-rotate(180deg)}' +
    '.header-btn-3{display:inline-flex;align-items:center;gap:.7em}' +
    '.header-btn-3::after{content:"";flex:none;width:30px;height:16px;border-radius:8px;border:1px solid #000;box-sizing:border-box;background-color:#fff;background-image:radial-gradient(circle,#000 0 5px,transparent 5.5px);background-repeat:no-repeat;background-size:14px 14px;background-position:1px center;transition:background-position .25s ease,background-color .25s ease}' +
    '.header-btn-3[aria-checked="true"]::after{background-color:#000;background-image:radial-gradient(circle,#fff 0 5px,transparent 5.5px);background-position:calc(100% - 1px) center}' +
    '.header-btn-3:focus-visible{outline:2px solid #000;outline-offset:-3px}' +
    '@media (prefers-reduced-motion:reduce){.header-btn-3::after{transition:none}}' +
    '.sp-mobile-menu{display:none;flex-direction:column;background:#000;color:#fff;border-top:1px solid #fff;font-family:"Apercu Mono Pro",monospace;text-transform:uppercase;font-size:.8rem}' +
    '.sp-mobile-menu.is-open{display:flex}' +
    '.sp-mobile-menu a{padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.2);color:#fff}';
  document.head.appendChild(style);

  function readTheme() {
    try {
      return window.localStorage.getItem(THEME_KEY);
    } catch (e) {
      return null;
    }
  }
  function applyTheme(dark) {
    document.documentElement.classList.toggle('dpm-dark', dark);
    var circle = document.querySelector('.toggle-circle');
    if (circle) circle.style.transform = dark ? 'translateX(16px)' : '';
    // The desktop button is a switch: say so to assistive technology and show its state.
    var desktopSwitch = document.querySelector('.header-btn-3');
    if (desktopSwitch) {
      desktopSwitch.setAttribute('role', 'switch');
      desktopSwitch.setAttribute('aria-checked', String(dark));
    }
  }
  applyTheme(readTheme() === 'dark');
  function toggleTheme() {
    var dark = !document.documentElement.classList.contains('dpm-dark');
    applyTheme(dark);
    try {
      window.localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
    } catch (e) {
      /* storage blocked */
    }
  }
  if (b3) b3.addEventListener('click', toggleTheme);
  var mobileToggle = document.querySelector('.dark-mode-toggle');
  if (mobileToggle) mobileToggle.addEventListener('click', toggleTheme);

  var hamburger = document.querySelector('.hamburger-menu');
  var mobileHeader = document.querySelector('.mobile-header');
  if (hamburger && mobileHeader) {
    var links = [
      ['SHOP ALL', '/collections/all'],
      ['APPAREL', '/collections/all'],
      ['TOP WEAR', '/collections/top-wear'],
      ['BOTTOM WEAR', '/collections/bottom-wear'],
      ['NEW IN', '/collections/new-in'],
      ['SEARCH', '/search'],
      ['ACCOUNT', '/account'],
      ['CONTACT', '/pages/contact'],
    ];
    var menu = document.createElement('nav');
    menu.className = 'sp-mobile-menu';
    menu.id = 'sp-mobile-menu';
    menu.setAttribute('aria-label', 'Main');
    links.forEach(function (l) {
      var a = document.createElement('a');
      a.textContent = l[0];
      a.href = l[1];
      menu.appendChild(a);
    });
    mobileHeader.appendChild(menu);
    hamburger.setAttribute('role', 'button');
    hamburger.setAttribute('tabindex', '0');
    hamburger.setAttribute('aria-label', 'Menu');
    hamburger.setAttribute('aria-controls', 'sp-mobile-menu');
    hamburger.setAttribute('aria-expanded', 'false');
    var toggleMenu = function () {
      var open = menu.classList.toggle('is-open');
      hamburger.setAttribute('aria-expanded', String(open));
    };
    hamburger.addEventListener('click', toggleMenu);
    hamburger.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleMenu();
      }
    });
  }

  // ---- Filter / sort panels on listing pages --------------------------------------------------
  document.querySelectorAll('[data-panel]').forEach(function (trigger) {
    var panel = document.getElementById(trigger.getAttribute('data-panel'));
    if (!panel) return;
    var setOpen = function (open) {
      panel.classList.toggle('is-open', open);
      trigger.setAttribute('aria-expanded', String(open));
    };
    var toggle = function () {
      setOpen(!panel.classList.contains('is-open'));
    };
    // The SORTED BY dropdown also opens while a mouse hovers over it and closes when the mouse leaves.
    var drop = trigger.closest('.sp-dropdown');
    var canHover = !!drop && window.matchMedia('(hover: hover)').matches;
    if (canHover) {
      drop.addEventListener('mouseenter', function () {
        setOpen(true);
      });
      drop.addEventListener('mouseleave', function () {
        // Do not close the FILTER form under someone who is typing in it.
        if (!panel.contains(document.activeElement) || document.activeElement.tagName === 'A') {
          setOpen(false);
        }
      });
    }
    if (drop) {
      // A click anywhere else closes it (also closes a form that was kept open for typing).
      document.addEventListener('click', function (e) {
        if (!drop.contains(e.target)) setOpen(false);
      });
    }
    // With a mouse the hover has already opened it, so a click keeps it open instead of closing it again.
    trigger.addEventListener('click', canHover ? function () { setOpen(true); } : toggle);
    trigger.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
    if (drop) {
      drop.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          setOpen(false);
          trigger.focus();
        }
      });
    }
  });

  // ---- Home page tile videos: show the video only once it is really playing ------------------------
  // The YouTube player is asked to report its state (enablejsapi=1). While it loads, and for the first moments
  // of playback (when YouTube shows its own buttons), the tile keeps showing its still picture.
  var tileVideos = document.querySelectorAll('.collection-video');
  if (tileVideos.length) {
    var revealTimers = [];
    tileVideos.forEach(function (box, i) {
      var frame = box.querySelector('iframe');
      var hello = function () {
        try {
          frame.contentWindow.postMessage(
            JSON.stringify({ event: 'listening', id: i + 1, channel: 'widget' }),
            '*',
          );
        } catch (err) {
          /* the picture simply stays */
        }
      };
      frame.addEventListener('load', hello);
      // the player may need to be asked again once its own scripts are ready
      window.setTimeout(hello, 1500);
      window.setTimeout(hello, 4000);
    });
    window.addEventListener('message', function (e) {
      if (!/^https:\/\/www\.youtube(-nocookie)?\.com$/.test(e.origin)) return;
      var data;
      try {
        data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      } catch (err) {
        return;
      }
      if (!data) return;
      var state;
      if (data.event === 'onStateChange') state = data.info;
      else if (data.event === 'infoDelivery' && data.info) state = data.info.playerState;
      if (state === undefined) return;
      tileVideos.forEach(function (box, i) {
        var frame = box.querySelector('iframe');
        if (!frame || frame.contentWindow !== e.source) return;
        // Once shown, the video stays shown (the brief buffering at each loop restart must not flash the picture).
        if (box.classList.contains('is-playing') || revealTimers[i]) return;
        if (state === 1) {
          revealTimers[i] = window.setTimeout(function () {
            box.classList.add('is-playing');
          }, 3500);
        }
      });
    });
  }

  // ---- Footer newsletter / wishlist sign-up --------------------------------------------------
  var newsForm = document.querySelector('.dpm-newsletter-form');
  if (newsForm) {
    var note = document.createElement('p');
    note.setAttribute('role', 'status');
    note.style.cssText =
      'margin:10px 0 0;font:12px "Apercu Mono Pro",monospace;color:#fff;text-transform:uppercase;min-height:1em';
    newsForm.appendChild(note);
    newsForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = new FormData(newsForm);
      var submit = newsForm.querySelector('input[type="submit"]');
      if (submit) submit.disabled = true;
      note.textContent = '';
      fetch('/api/newsletter', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          firstname: data.get('firstname'),
          email: data.get('email'),
          phone: data.get('phone'),
        }),
      })
        .then(function (res) {
          return res.json().catch(function () {
            return { ok: false, message: 'Something went wrong.' };
          });
        })
        .then(function (json) {
          note.textContent = json.message || (json.ok ? 'Thank you.' : 'Something went wrong.');
          if (json.ok) newsForm.reset();
        })
        .catch(function () {
          note.textContent = 'Could not reach the server. Please try again.';
        })
        .then(function () {
          if (submit) submit.disabled = false;
        });
    });
  }

  // ---- Bag: BAG[n] label, links to the /cart page, add to bag -------------------------------
  function setBagCount(n) {
    document.querySelectorAll('a, span').forEach(function (el) {
      if (el.children.length === 0 && /^BAG\[\d+\]$/.test(el.textContent.trim())) {
        el.textContent = 'BAG[' + n + ']';
      }
    });
  }
  fetch('/api/cart/count', { headers: { accept: 'application/json' } })
    .then(function (r) {
      return r.json();
    })
    .then(function (j) {
      if (j && j.ok) setBagCount(j.count);
    })
    .catch(function () {
      /* the label simply keeps its default */
    });
  document.querySelectorAll('.bag-link').forEach(function (el) {
    if (el.tagName !== 'A')
      makeLink(el, 'Shopping bag', function () {
        go('/cart');
      });
  });

  var toast = null;
  var toastTimer = 0;
  function showToast(text, withLink) {
    if (!toast) {
      toast = document.createElement('div');
      toast.setAttribute('role', 'status');
      toast.style.cssText =
        'position:fixed;left:50%;top:48px;transform:translateX(-50%);z-index:5000;background:#000;color:#fff;' +
        'padding:16px 22px;font:15px "Apercu Mono Pro",monospace;text-transform:uppercase;max-width:90vw;border:1px solid #fff;' +
        'box-shadow:0 10px 30px rgba(0,0,0,0.25)';
      document.body.appendChild(toast);
    }
    toast.textContent = text + ' ';
    if (withLink) {
      var a = document.createElement('a');
      a.href = '/cart';
      a.textContent = '[VIEW BAG]';
      a.style.cssText = 'color:#fff;text-decoration:underline;margin-left:8px';
      toast.appendChild(a);
    }
    toast.style.display = 'block';
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toast.style.display = 'none';
    }, 5000);
  }

  var ERRORS = {
    QTY_EXCEEDS_AVAILABLE: 'Not enough stock for that quantity',
    OUT_OF_STOCK: 'That size is sold out',
    PRODUCT_UNAVAILABLE: 'That item is no longer available',
    RATE_LIMITED: 'Too many requests, please wait a moment',
  };
  // The button text changes while adding ("ADDING..." then "ADDED") so the click is clearly seen.
  var addLabels = document.querySelectorAll('.add-to-cart-bar > span:first-child, .add-to-bag-btn-text');
  var addLabelText = [];
  addLabels.forEach(function (el, i) {
    addLabelText[i] = el.textContent;
  });
  var addTimer = 0;
  var adding = false;
  function setAddLabel(text) {
    addLabels.forEach(function (el, i) {
      el.textContent = text === null ? addLabelText[i] : text;
    });
  }
  function addToBag() {
    if (adding) return;
    var chosen =
      document.querySelector('.size-btn.selected:not(:disabled)') ||
      document.querySelector('.size-selector button.active:not(:disabled)');
    var id = chosen && chosen.getAttribute('data-variant-id');
    if (!id) {
      showToast('Choose an available size first', false);
      return;
    }
    adding = true;
    window.clearTimeout(addTimer);
    setAddLabel('ADDING...');
    fetch('/api/cart/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ variantId: id, qty: 1 }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (j.ok) {
          setBagCount(j.count);
          setAddLabel('ADDED ✓');
          showToast('Added to bag', true);
          addTimer = window.setTimeout(function () {
            setAddLabel(null);
          }, 2200);
        } else {
          setAddLabel(null);
          showToast(ERRORS[j.code] || 'Could not add to bag', false);
        }
      })
      .catch(function () {
        setAddLabel(null);
        showToast('Could not reach the server', false);
      })
      .then(function () {
        adding = false;
      });
  }
  document.querySelectorAll('.add-to-bag-btn').forEach(function (b) {
    b.addEventListener('click', addToBag);
  });
  document.querySelectorAll('.add-to-cart-bar').forEach(function (b) {
    makeLink(b, 'Add to bag', addToBag);
    b.setAttribute('role', 'button');
  });
})();
