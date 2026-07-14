'use strict';

/** Bottom gap (px) reserved under BrowserView for the React Design Mode pill. */
const DESIGN_MODE_OVERLAY_RESERVE_PX = 64;

const MAX_HTML_CHARS = 4000;
const MAX_COMPONENTS = 8;

const STYLE_KEYS = [
  'display',
  'position',
  'width',
  'height',
  'margin',
  'padding',
  'fontSize',
  'fontWeight',
  'color',
  'backgroundColor',
  'border',
  'borderRadius',
  'flexDirection',
  'justifyContent',
  'alignItems',
  'gap',
  'gridTemplateColumns',
];

const NOISE_CLASSES = new Set([
  'active',
  'disabled',
  'focus',
  'focused',
  'hover',
  'hidden',
  'open',
  'selected',
  'show',
  'visible',
]);

function truncateHtml(html) {
  const text = typeof html === 'string' ? html : '';
  if (text.length <= MAX_HTML_CHARS) return text;
  return `${text.slice(0, MAX_HTML_CHARS - 1)}…`;
}

function roundBox(bbox) {
  if (!bbox || typeof bbox !== 'object') {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return {
    x: Math.round(Number(bbox.x) || 0),
    y: Math.round(Number(bbox.y) || 0),
    width: Math.max(0, Math.round(Number(bbox.width) || 0)),
    height: Math.max(0, Math.round(Number(bbox.height) || 0)),
  };
}

function pickStyles(styles) {
  if (!styles || typeof styles !== 'object') return {};
  const out = {};
  for (const key of STYLE_KEYS) {
    const value = styles[key];
    if (typeof value === 'string' && value.trim()) out[key] = value;
  }
  return out;
}

function isObfuscatedClass(name) {
  if (!name || name.includes('-') || name.includes('_')) return false;
  if (/^[A-Z]{2,}[A-Za-z0-9]{2,}$/.test(name)) return true;
  if (/^[a-z]{1,3}[A-Z][A-Za-z0-9]{3,}$/.test(name) && name.length <= 12) return true;
  return false;
}

function firstMeaningfulClass(className) {
  return (
    String(className || '')
      .trim()
      .split(/\s+/)
      .find(
        (part) =>
          part &&
          !NOISE_CLASSES.has(part.toLowerCase()) &&
          !isObfuscatedClass(part) &&
          !/^[:\[]/.test(part),
      ) ?? ''
  );
}

function designModeElementLabel(input) {
  const tag = (input.tag || 'element').trim().toLowerCase() || 'element';
  const aria = String(input.ariaLabel || '').trim();
  if (aria) return aria.length > 40 ? `${aria.slice(0, 39)}…` : aria;
  const placeholder = String(input.placeholder || '').trim();
  if (placeholder) return placeholder.length > 40 ? `${placeholder.slice(0, 39)}…` : placeholder;
  const name = String(input.name || '').trim();
  if (name) return name;
  const id = String(input.id || '').trim();
  if (id) {
    const pascal = /^[A-Z][A-Za-z0-9_$]*$/.test(id);
    const camel = /^[a-z][A-Za-z0-9_$]*$/.test(id) && /[A-Z]/.test(id);
    if (pascal || camel) return id;
    return `${tag}#${id}`;
  }
  const cls = firstMeaningfulClass(input.className || '');
  if (cls) return `${tag}.${cls}`;
  const text = String(input.text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text && text.length <= 32) return `${tag} “${text}”`;
  return tag;
}

function normalizeGuestPick(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('design mode pick payload is required');
  }
  const tag = typeof raw.tag === 'string' ? raw.tag.trim().toLowerCase() : '';
  if (!tag) {
    throw new Error('design mode pick requires a tag');
  }

  const base = {
    tag,
    id: typeof raw.id === 'string' ? raw.id : '',
    className: typeof raw.className === 'string' ? raw.className : '',
    ariaLabel: typeof raw.ariaLabel === 'string' ? raw.ariaLabel : '',
    placeholder: typeof raw.placeholder === 'string' ? raw.placeholder : '',
    name: typeof raw.name === 'string' ? raw.name : '',
    text: typeof raw.text === 'string' ? raw.text : '',
    xpath: typeof raw.xpath === 'string' ? raw.xpath : '',
    cssPath: typeof raw.cssPath === 'string' ? raw.cssPath : '',
    outerHTML: truncateHtml(raw.outerHTML),
    styles: pickStyles(raw.styles),
    bbox: roundBox(raw.bbox),
    cropPngBase64:
      typeof raw.cropPngBase64 === 'string' && raw.cropPngBase64.trim()
        ? raw.cropPngBase64.trim()
        : undefined,
  };
  return {
    ...base,
    label:
      typeof raw.label === 'string' && raw.label.trim()
        ? raw.label.trim()
        : designModeElementLabel(base),
  };
}

/**
 * Guest script: hover highlight + click → reportPick.
 * Chat UI lives in React (cannot paint over BrowserView); keep guest side lean.
 */
function buildPickerInstallScript() {
  return `(() => {
  // Re-entrant: drop any prior listeners/nodes, then install fresh.
  const prev = window.__nuncioDesignModeHandlers;
  if (prev) {
    document.removeEventListener('mousemove', prev.onMove, true);
    document.removeEventListener('click', prev.onClick, true);
    document.removeEventListener('keydown', prev.onKey, true);
  }
  const oldHl = document.getElementById('__nuncio-design-mode-highlight');
  if (oldHl) oldHl.remove();
  const oldBar = document.getElementById('__nuncio-design-mode-bar');
  if (oldBar) oldBar.remove();

  window.__nuncioDesignModeActive = true;
  const MAX_HTML_CHARS = ${MAX_HTML_CHARS};
  const STYLE_KEYS = ${JSON.stringify(STYLE_KEYS)};
  const HIGHLIGHT_ID = '__nuncio-design-mode-highlight';

  const highlight = document.createElement('div');
  highlight.id = HIGHLIGHT_ID;
  Object.assign(highlight.style, {
    position: 'fixed', pointerEvents: 'none', zIndex: '2147483646',
    border: '2px solid #3b82f6', background: 'rgba(59, 130, 246, 0.12)',
    boxSizing: 'border-box', display: 'none',
  });
  (document.documentElement || document.body).appendChild(highlight);

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
  }

  function cssPathFor(el) {
    if (!(el instanceof Element)) return '';
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 8) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += '#' + cssEscape(node.id);
        parts.unshift(part);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      const cls = typeof node.className === 'string'
        ? node.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : [];
      if (cls.length) part += '.' + cls.map(cssEscape).join('.');
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  function xpathFor(el) {
    if (!(el instanceof Element)) return '';
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      let index = 1;
      let sibling = node.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === node.tagName) index += 1;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(node.tagName.toLowerCase() + '[' + index + ']');
      node = node.parentElement;
    }
    return '/' + parts.join('/');
  }

  function styleSnapshot(el) {
    const cs = window.getComputedStyle(el);
    const out = {};
    for (const key of STYLE_KEYS) {
      const cssKey = key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
      out[key] = cs.getPropertyValue(cssKey) || cs[key] || '';
    }
    return out;
  }

  function moveHighlight(el) {
    if (!(el instanceof Element) || el === highlight) {
      highlight.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(highlight.style, {
      display: 'block', left: r.left + 'px', top: r.top + 'px',
      width: Math.max(0, r.width) + 'px', height: Math.max(0, r.height) + 'px',
    });
  }

  function onMove(event) {
    moveHighlight(document.elementFromPoint(event.clientX, event.clientY));
  }

  function onClick(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const el = path.find((n) => n instanceof Element && n !== highlight) ||
      document.elementFromPoint(event.clientX, event.clientY);
    if (!(el instanceof Element) || el === highlight) return;
    const r = el.getBoundingClientRect();
    const payload = {
      tag: el.tagName,
      id: el.id || '',
      className: typeof el.className === 'string' ? el.className : '',
      ariaLabel: el.getAttribute('aria-label') || '',
      placeholder: el.getAttribute('placeholder') || '',
      name: el.getAttribute('name') || '',
      text: (el.innerText || el.textContent || '').slice(0, 80),
      xpath: xpathFor(el),
      cssPath: cssPathFor(el),
      outerHTML: (el.outerHTML || '').slice(0, MAX_HTML_CHARS),
      styles: styleSnapshot(el),
      bbox: { x: r.x, y: r.y, width: r.width, height: r.height },
    };
    try {
      window.__nuncioDesignModeBridge && window.__nuncioDesignModeBridge.reportPick(payload);
    } catch (_) {}
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      try {
        window.__nuncioDesignModeBridge && window.__nuncioDesignModeBridge.exitDesignMode();
      } catch (_) {}
    }
  }

  window.__nuncioDesignModeHandlers = { onMove, onClick, onKey };
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  return true;
})();`;
}

function buildPickerUninstallScript() {
  return `(() => {
  const handlers = window.__nuncioDesignModeHandlers;
  if (handlers) {
    document.removeEventListener('mousemove', handlers.onMove, true);
    document.removeEventListener('click', handlers.onClick, true);
    document.removeEventListener('keydown', handlers.onKey, true);
    window.__nuncioDesignModeHandlers = null;
  }
  const highlight = document.getElementById('__nuncio-design-mode-highlight');
  if (highlight) highlight.remove();
  const bar = document.getElementById('__nuncio-design-mode-bar');
  if (bar) bar.remove();
  window.__nuncioDesignModeActive = false;
  return true;
})();`;
}

module.exports = {
  DESIGN_MODE_OVERLAY_RESERVE_PX,
  MAX_HTML_CHARS,
  MAX_COMPONENTS,
  STYLE_KEYS,
  designModeElementLabel,
  normalizeGuestPick,
  buildPickerInstallScript,
  buildPickerUninstallScript,
};
