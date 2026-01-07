(function () {
    if (window.__saveToThymerInjected) return;
    window.__saveToThymerInjected = true;

    // Cached patterns for performance
    const PLACEHOLDER_PATTERN = /loading|placeholder|spinner|lazy|transparent|blank|spacer|pixel|1x1|avatar|icon|logo|badge|button/i;
    const YOUTUBE_PATTERN = /youtube\.com|youtu\.be/;
    const REMOVE_SELECTORS = 'script,style,nav,footer,header,aside,noscript,[role="navigation"],[role="banner"],[role="contentinfo"],.nav,.navbar,.footer,.header,.sidebar,.menu,.ad,.ads,.advertisement,.social-share,.share-buttons,.comments,#comments,.related-posts,.recommended,form,iframe,svg,button,.button,[hidden],[aria-hidden="true"]';

    chrome.runtime.onMessage.addListener((msg, sender, respond) => {
        if (msg.type === 'PING') { respond({ pong: true }); return true; }
        if (msg.type === 'GET_PAGE_DATA') { respond(extractPageData()); return true; }
    });

    function extractPageData() {
        const ogImage = getMeta('og:image') || getMeta('twitter:image');
        return {
            title: getMeta('og:title') || getMeta('twitter:title') || document.title || '',
            url: location.href,
            description: getMeta('og:description') || getMeta('description') || '',
            ogImage: isYouTube() ? getYouTubeThumbnail() : ogImage,
            images: getPageImages(ogImage),
            bodyMarkdown: extractBodyMarkdown()
        };
    }

    function getMeta(name) {
        return document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute('content') || null;
    }

    function getPageImages(ogImage) {
        const images = new Set();
        if (ogImage) images.add(ogImage);
        document.querySelectorAll('img').forEach(img => {
            const src = getImageSrc(img);
            if (!src || isPlaceholderImage(src)) return;
            if (img.naturalWidth && img.naturalWidth < 100) return;
            try { images.add(new URL(src, location.href).href); } catch { }
        });
        return [...images].slice(0, 15);
    }

    function isYouTube() {
        return YOUTUBE_PATTERN.test(location.hostname);
    }

    function getYouTubeThumbnail() {
        const videoId = new URLSearchParams(location.search).get('v') ||
            location.pathname.match(/^\/([a-zA-Z0-9_-]{11})/)?.[1] ||
            location.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/)?.[1];
        return videoId ? `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg` : getMeta('og:image');
    }

    function getImageSrc(img) {
        return img.src || img.dataset.src || img.dataset.lazySrc || img.dataset.original || img.getAttribute('data-src');
    }

    function isPlaceholderImage(src) {
        if (!src || src.startsWith('data:')) return true;
        return PLACEHOLDER_PATTERN.test(src);
    }

    function findMainContent() {
        const selectors = [
            'article',
            '[role="main"]',
            '[itemprop="articleBody"]',
            'main',
            '.post-content',
            '.entry-content',
            '.article-content',
            '.article-body',
            '.post-body',
            '.content-body',
            '#content',
            '.content',
            '.post',
            '.entry'
        ];

        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.textContent.trim().length > 200) return el;
        }

        return findByTextDensity() || document.body;
    }

    function findByTextDensity() {
        let best = null;
        let bestScore = 0;

        document.querySelectorAll('div, section').forEach(el => {
            if (el.closest('nav, header, footer, aside, .sidebar, .menu, .nav')) return;
            const text = el.textContent || '';
            const links = el.querySelectorAll('a').length;
            const paragraphs = el.querySelectorAll('p').length;
            if (paragraphs < 2) return;

            const score = text.length / (links + 1) * paragraphs;
            if (score > bestScore && text.length > 500) {
                bestScore = score;
                best = el;
            }
        });
        return best;
    }

    function extractBodyMarkdown() {
        const content = findMainContent();
        const clone = content.cloneNode(true);

        // Remove non-content elements using cached selector
        clone.querySelectorAll(REMOVE_SELECTORS).forEach(el => el.remove());

        // Remove hidden elements
        clone.querySelectorAll('*').forEach(el => {
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') el.remove();
        });

        return convertToMarkdown(clone);
    }

    function convertToMarkdown(element) {
        function process(node) {
            if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent.replace(/\s+/g, ' ').trim();
                return text;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return '';

            const tag = node.tagName.toLowerCase();
            const children = [...node.childNodes].map(process).filter(Boolean).join('');
            if (!children && !['img', 'br', 'hr'].includes(tag)) return '';

            switch (tag) {
                case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
                    return '\n' + '#'.repeat(parseInt(tag[1], 10)) + ' ' + children.trim() + '\n\n';
                case 'p': return children.trim() + '\n\n';
                case 'br': return '\n';
                case 'hr': return '\n---\n\n';
                case 'strong': case 'b': return `**${children}**`;
                case 'em': case 'i': return `*${children}*`;
                case 'code': return `\`${children}\``;
                case 'pre':
                    const lang = node.querySelector('code')?.className?.match(/language-(\w+)/)?.[1] || '';
                    return '\n```' + lang + '\n' + node.textContent.trim() + '\n```\n\n';
                case 'blockquote': return '\n> ' + children.trim().replace(/\n/g, '\n> ') + '\n\n';
                case 'a':
                    const href = node.getAttribute('href');
                    if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
                        try { return `[${children}](${new URL(href, location.href).href})`; } catch { }
                    }
                    return children;
                case 'img':
                    const src = getImageSrc(node);
                    if (!src || isPlaceholderImage(src)) return '';
                    try { return `![${node.getAttribute('alt') || ''}](${new URL(src, location.href).href})\n\n`; } catch { }
                    return '';
                case 'ul':
                    return '\n' + [...node.children].map(li => '- ' + [...li.childNodes].map(process).filter(Boolean).join('').trim()).join('\n') + '\n\n';
                case 'ol':
                    return '\n' + [...node.children].map((li, i) => `${i + 1}. ` + [...li.childNodes].map(process).filter(Boolean).join('').trim()).join('\n') + '\n\n';
                case 'li': return children;
                case 'figure':
                    return [...node.childNodes].map(process).filter(Boolean).join('');
                case 'figcaption':
                    return '*' + children.trim() + '*\n\n';
                default: return children;
            }
        }

        return process(element)
            .replace(/\n{3,}/g, '\n\n')
            .replace(/^\s+|\s+$/g, '')
            .slice(0, 50000);
    }
})();
