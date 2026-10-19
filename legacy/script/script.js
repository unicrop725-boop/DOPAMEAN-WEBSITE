document.addEventListener('DOMContentLoaded', () => {
    const timeElement = document.getElementById('mobile-time');
    function updateLiveTime() {
        if (!timeElement) return;
        const now = new Date();
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        timeElement.textContent = `${hours}:${minutes}:${seconds}`;
    }
    updateLiveTime();
    setInterval(updateLiveTime, 1000);

    // --- Accordion Logic ---

    const accordionItems = document.querySelectorAll('.dpm-accordion-item');
    const animationOptions = {
        duration: 400,
        easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
        fill: 'forwards'
    };

    function toggleAccordion(item) {
        const content = item.querySelector('.dpm-accordion-content');
        const isOpen = item.classList.contains('is-open');
        item.dataset.animating = 'true';

        const keyframes = isOpen
            ? [{ height: `${content.scrollHeight}px`, opacity: 1 }, { height: '0px', opacity: 0 }]
            : [{ height: '0px', opacity: 0 }, { height: `${content.scrollHeight}px`, opacity: 1 }];

        const animation = content.animate(keyframes, animationOptions);
        item.classList.toggle('is-open');

        animation.onfinish = () => {
            if (item.classList.contains('is-open')) {
                content.style.height = 'auto';
            }
            delete item.dataset.animating;
        };
    }

    
    accordionItems.forEach(item => {
        const header = item.querySelector('.dpm-accordion-header');
        const content = item.querySelector('.dpm-accordion-content');

        if (item.classList.contains('is-open')) {
            content.style.height = 'auto';
        } else {
            content.style.height = '0px';
            content.style.opacity = '0';
            content.style.overflow = 'hidden';
        }

        header.addEventListener('click', () => {
            if (item.dataset.animating) return;
            accordionItems.forEach(otherItem => {
                if (otherItem !== item && otherItem.classList.contains('is-open')) {
                    toggleAccordion(otherItem);
                }
            });
            toggleAccordion(item);
        });
    });
});



document.addEventListener('DOMContentLoaded', function () {
    const mobileTimeElement = document.getElementById('mobile-time');
    const desktopTimeElement = document.getElementById('desktop-time');

    function updateTime() {
        const now = new Date();
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        const formattedTime = `${hours}:${minutes}:${seconds}`;

        if (mobileTimeElement) {
            mobileTimeElement.textContent = formattedTime;
        }
        if (desktopTimeElement) {
            desktopTimeElement.textContent = `[ INDIA ${formattedTime} HH ]`;
        }
    }
    updateTime();
    setInterval(updateTime, 1000);
});




document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.accordion-header').forEach(header => {
        header.addEventListener('click', () => {
            const clickedItem = header.parentElement;
            const currentlyActiveItem = document.querySelector('.accordion-item.active');
            if (currentlyActiveItem && currentlyActiveItem !== clickedItem) {
                currentlyActiveItem.classList.remove('active');
                const activeHeader = currentlyActiveItem.querySelector('.accordion-header');
                activeHeader.setAttribute('aria-expanded', 'false');
                activeHeader.querySelector('.icon').textContent = '+';
            }
            clickedItem.classList.toggle('active');
            const icon = header.querySelector('.icon');
            const isExpanded = clickedItem.classList.contains('active');
            header.setAttribute('aria-expanded', isExpanded);
            icon.textContent = isExpanded ? '-' : '+';
        });
    });

    // --- SIZE SELECTOR LOGIC ---

    const sizeButtons = document.querySelectorAll('.size-selector button');
    sizeButtons.forEach(button => {
        button.addEventListener('click', () => {
            sizeButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');
        });
    });

    // --- SIZE CHART MODAL LOGIC ---

    const sizeGuideLink = document.querySelector('.size-guide');
    const sizeChartOverlay = document.querySelector('.size-chart-overlay');
    const closeChartButton = document.querySelector('.close-chart-btn');
    const openModal = () => sizeChartOverlay.classList.add('active');
    const closeModal = () => sizeChartOverlay.classList.remove('active');

    sizeGuideLink.addEventListener('click', (e) => {
        e.preventDefault();
        openModal();
    });

    closeChartButton.addEventListener('click', closeModal);

    sizeChartOverlay.addEventListener('click', (e) => {
        if (e.target === sizeChartOverlay) closeModal();
    });

    // --- NEW: CLOSE SIZE CHART ON SCROLL ---

    window.addEventListener('scroll', () => {
        if (sizeChartOverlay.classList.contains('active')) {
            closeModal();
        }
    });
});

document.addEventListener('DOMContentLoaded', () => {
    const shoppingBag = document.querySelector('.shopping-bag-container');
    const overlay = document.querySelector('.overlay');

    const openBtn = document.getElementById('open-bag-link');
    const closeBtn = document.getElementById('close-bag-btn');

    const openBag = () => {
        shoppingBag.classList.add('is-visible');
        overlay.classList.add('is-visible');
    };

    const closeBag = () => {
        shoppingBag.classList.remove('is-visible');
        overlay.classList.remove('is-visible');
    };


    openBtn.addEventListener('click', (e) => {
        e.preventDefault();
        openBag();
    });

    closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        closeBag();
    });

    overlay.addEventListener('click', closeBag);
})

// --- Mobile Logic for sticky-to-fixed transition ---

if (window.innerWidth < 1024) {
    const componentContainer = document.getElementById('component-container');
    const productDock = document.getElementById('product-dock');

    const observer = new IntersectionObserver(
        (entries) => {
            const entry = entries[0];
            if (!entry.isIntersecting && entry.boundingClientRect.top > 0) {
                componentContainer.classList.remove('is-docked');
            } else {
                componentContainer.classList.add('is-docked');
            }
        },
        { rootMargin: '0px 0px 0px 0px', threshold: 0 }
    );
    if (productDock) {
        observer.observe(productDock);
    }
}

// --- Shared Logic for size selection ---
const sizeButtons = document.querySelectorAll('.size-btn');
sizeButtons.forEach(button => {
    button.addEventListener('click', () => {
        sizeButtons.forEach(btn => btn.classList.remove('selected'));
        button.classList.add('selected');
    });
});

// --- Desktop Logic for Accordion ---
if (window.innerWidth >= 1024) {
    document.querySelectorAll('.accordion-header').forEach(header => {
        header.addEventListener('click', () => {
            const accordionItem = header.parentElement;
            const content = header.nextElementSibling;
            const icon = header.querySelector('.icon');
            const isActive = accordionItem.classList.contains('active');

            document.querySelectorAll('.accordion-item').forEach(item => {
                if (item !== accordionItem) {
                    item.classList.remove('active');
                    item.querySelector('.accordion-content').style.maxHeight = '0px';
                    item.querySelector('.icon').textContent = '+';
                }
            });

            if (isActive) {
                accordionItem.classList.remove('active');
                content.style.maxHeight = '0px';
                icon.textContent = '+';
            } else {
                accordionItem.classList.add('active');
                content.style.maxHeight = content.scrollHeight + 'px';
                icon.textContent = '-';
            }
        });
    });

    // --- Desktop Logic for Size Selector ---
    document.querySelectorAll('.size-selector button').forEach(button => {
        button.addEventListener('click', () => {
            document.querySelectorAll('.size-selector button').forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');
        });
    });

    // --- Desktop Clock Logic ---
    function updateTime() {
        const timeElement = document.getElementById('time1');
        if (timeElement) {
            const now = new Date();
            const timeString = now.toLocaleTimeString('en-US', { hour12: false });
            timeElement.textContent = `[INDIA ${timeString}]`;
        }
    }
    setInterval(updateTime, 1000);
    updateTime();

    // --- Desktop Thumbnail Gallery Logic ---

    const thumbnails = document.querySelectorAll('.thumbnail-gallery img');
    const imageScroller = document.querySelector('.product-image-scroller');
    const imageCards = document.querySelectorAll('.product-image-card');

    thumbnails.forEach((thumbnail, index) => {
        thumbnail.addEventListener('click', () => {
            if (imageCards[index]) {
                imageCards[index].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
            }
        });
    });
}




document.addEventListener('DOMContentLoaded', () => {

    document.querySelectorAll('.accordion-header').forEach(button => {
        button.addEventListener('click', () => {
            const accordionItem = button.parentElement;
            const accordionContent = button.nextElementSibling;
            const icon = button.querySelector('.icon');

            accordionItem.classList.toggle('active');

            if (accordionItem.classList.contains('active')) {
                accordionContent.style.maxHeight = accordionContent.scrollHeight + 'px';
                icon.textContent = '-';
            } else {
                accordionContent.style.maxHeight = 0;
                icon.textContent = '+';
            }
        });
    });

    // --- Size Guide Modal Logic (with scroll-to-close) ---

    const sizeGuideModal = document.getElementById('size-guide-modal');
    const openDesktopLink = document.getElementById('size-guide-link');
    const openMobileLink = document.querySelector('.size-guide-link-mobile');
    const closeModalButton = document.getElementById('modal-close-button');
    const closeModalOnScroll = () => {
        closeModal();
    };

    const openModal = (event) => {
        event.preventDefault();
        if (sizeGuideModal) {
            sizeGuideModal.classList.add('visible');
            window.addEventListener('scroll', closeModalOnScroll);
        }
    };
    const closeModal = () => {
        if (sizeGuideModal) {
            sizeGuideModal.classList.remove('visible');
            window.removeEventListener('scroll', closeModalOnScroll);
        }
    };
    if (openDesktopLink) openDesktopLink.addEventListener('click', openModal);
    if (openMobileLink) openMobileLink.addEventListener('click', openModal);
    if (closeModalButton) closeModalButton.addEventListener('click', closeModal);
    if (sizeGuideModal) {
        sizeGuideModal.addEventListener('click', (event) => {
            if (event.target === sizeGuideModal) {
                closeModal();
            }
        });
    }
});




