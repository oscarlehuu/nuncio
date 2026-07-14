/**
 * Design Mode draft ↔ steer payload helpers (provider-neutral).
 * Readable element chips (aria / id / class / tag) inline in the prompt.
 */

import type { MessageAttachment } from '@nuncio/core';

export const DESIGN_MODE_MAX_COMPONENTS = 8;
export const DESIGN_MODE_MAX_HTML_CHARS = 4000;
/** Floating pill sits in a React gap under BrowserView (~64px). */
export const DESIGN_MODE_OVERLAY_RESERVE_PX = 64;

export interface DesignModeBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesignModeComponent {
  index: number;
  label: string;
  tag: string;
  id: string;
  className: string;
  ariaLabel?: string;
  placeholder?: string;
  name?: string;
  text?: string;
  xpath: string;
  cssPath: string;
  outerHTML: string;
  styles: Record<string, string>;
  bbox: DesignModeBBox;
  cropPngBase64?: string;
}

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

function isObfuscatedClass(name: string): boolean {
  if (!name || name.includes('-') || name.includes('_')) return false;
  if (/^[A-Z]{2,}[A-Za-z0-9]{2,}$/.test(name)) return true;
  if (/^[a-z]{1,3}[A-Z][A-Za-z0-9]{3,}$/.test(name) && name.length <= 12) return true;
  return false;
}

function firstMeaningfulClass(className: string): string {
  return (
    className
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

export function designModeElementLabel(input: {
  tag: string;
  id?: string;
  className?: string;
  ariaLabel?: string;
  placeholder?: string;
  name?: string;
  text?: string;
}): string {
  const tag = (input.tag || 'element').trim().toLowerCase() || 'element';
  const aria = (input.ariaLabel ?? '').trim();
  if (aria) return aria.length > 40 ? `${aria.slice(0, 39)}…` : aria;
  const placeholder = (input.placeholder ?? '').trim();
  if (placeholder) return placeholder.length > 40 ? `${placeholder.slice(0, 39)}…` : placeholder;
  const name = (input.name ?? '').trim();
  if (name) return name;
  const id = (input.id ?? '').trim();
  if (id) {
    const pascal = /^[A-Z][A-Za-z0-9_$]*$/.test(id);
    const camel = /^[a-z][A-Za-z0-9_$]*$/.test(id) && /[A-Z]/.test(id);
    if (pascal || camel) return id;
    return `${tag}#${id}`;
  }
  const cls = firstMeaningfulClass(input.className ?? '');
  if (cls) return `${tag}.${cls}`;
  const text = (input.text ?? '').replace(/\s+/g, ' ').trim();
  if (text && text.length <= 32) return `${tag} “${text}”`;
  return tag;
}

export function componentChipToken(label: string): string {
  return `[${label}]`;
}

function disambiguateLabel(base: string, existing: DesignModeComponent[]): string {
  const taken = new Set(existing.map((c) => c.label));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}·${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}·${existing.length + 1}`;
}

export interface DesignModeTextInsertResult {
  text: string;
  caret: number;
  components: DesignModeComponent[];
  capped: boolean;
}

export function insertComponentChipAtCaret(
  text: string,
  caret: number,
  component: Omit<DesignModeComponent, 'index' | 'label'>,
  existing: DesignModeComponent[] = [],
): DesignModeTextInsertResult {
  if (existing.length >= DESIGN_MODE_MAX_COMPONENTS) {
    return { text, caret, components: existing, capped: true };
  }

  const index = existing.length + 1;
  const label = disambiguateLabel(designModeElementLabel(component), existing);
  const token = componentChipToken(label);
  const at = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before.length === 0 || /\s$/.test(before) ? '' : ' ';
  const trail = after.length === 0 || /^\s/.test(after) ? '' : ' ';
  const inserted = `${lead}${token}${trail || ' '}`;
  const nextText = `${before}${inserted}${after}`;
  const nextCaret = before.length + inserted.length;

  return {
    text: nextText,
    caret: nextCaret,
    components: [...existing, { ...component, index, label }],
    capped: false,
  };
}

function formatComponentBlock(component: DesignModeComponent): string {
  const styles = Object.entries(component.styles)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
  const html =
    component.outerHTML.length > DESIGN_MODE_MAX_HTML_CHARS
      ? `${component.outerHTML.slice(0, DESIGN_MODE_MAX_HTML_CHARS - 1)}…`
      : component.outerHTML;
  const { x, y, width, height } = component.bbox;
  return [
    `[${component.label}]`,
    `tag: ${component.tag}`,
    component.id ? `id: ${component.id}` : null,
    component.className ? `class: ${component.className}` : null,
    component.xpath ? `xpath: ${component.xpath}` : null,
    component.cssPath ? `cssPath: ${component.cssPath}` : null,
    `bbox: ${x},${y} ${width}x${height}`,
    html ? `html: ${html}` : null,
    styles ? `styles: { ${styles} }` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

export interface DesignModeSteerPayload {
  message: string;
  attachments: MessageAttachment[];
}

export function buildDesignModeSteerMessage(
  text: string,
  components: DesignModeComponent[],
): DesignModeSteerPayload {
  const prompt = text.trim();
  if (!prompt && components.length === 0) {
    throw new Error('Design Mode steer is empty');
  }

  const appendix =
    components.length === 0
      ? ''
      : `\n\n---\n${components.map(formatComponentBlock).join('\n\n')}\n---`;

  const attachments: MessageAttachment[] = components
    .filter((c) => typeof c.cropPngBase64 === 'string' && c.cropPngBase64.length > 0)
    .map((c) => ({
      kind: 'image' as const,
      mimeType: 'image/png',
      data: c.cropPngBase64!,
    }));

  return {
    message: `${prompt}${appendix}`,
    attachments,
  };
}

export function designModeComponentFromPick(
  pick: {
    tag: string;
    id?: string;
    className?: string;
    ariaLabel?: string;
    placeholder?: string;
    name?: string;
    text?: string;
    xpath?: string;
    cssPath?: string;
    outerHTML?: string;
    styles?: Record<string, string>;
    bbox?: DesignModeBBox;
    cropPngBase64?: string;
    label?: string;
  },
): Omit<DesignModeComponent, 'index' | 'label'> {
  return {
    tag: pick.tag,
    id: pick.id ?? '',
    className: pick.className ?? '',
    ariaLabel: pick.ariaLabel,
    placeholder: pick.placeholder,
    name: pick.name,
    text: pick.text,
    xpath: pick.xpath ?? '',
    cssPath: pick.cssPath ?? '',
    outerHTML: pick.outerHTML ?? '',
    styles: pick.styles ?? {},
    bbox: pick.bbox ?? { x: 0, y: 0, width: 0, height: 0 },
    cropPngBase64: pick.cropPngBase64,
  };
}
