# Composer controls audit

## Evidence

- Reference: `codex-clipboard-bc6b4715-e490-499e-8f01-15b8ebeca998.png`
- Desktop result: `desktop-home-after-dark.png`
- Mobile result: `mobile-home-after.png`
- Persistent form result: `desktop-loop-modal-after.png`

## Findings and verification

1. The old permission chip created a second control tier and made the composer engine-specific. It is removed from Home and session steer surfaces; provider-request cards remain available when a provider explicitly asks for input.
2. Solo/Crew is now one compact segmented radio group: 139 x 40 px overall with 36 px targets, no outer border, and retained keyboard/radio semantics.
3. Chat and engine-model surfaces use the same `ModelPicker` trigger contract and compact density. The catalog still opens as the same searchable, provider-filtered flat panel.
4. The 390 px run reports `clientWidth = scrollWidth = 390`; the composer control row uses its existing horizontal overflow rather than widening the page.
5. Form dialogs opt into blocked outside dismissal. A real-browser click at `(10, 10)`, outside the New loop dialog bounds, left the dialog open. Cancel, Close, and Escape remain exits.
6. Light and dark themes were visually checked. No clipped controls, new palette, or typography changes were introduced.

## Runtime defaults

- Codex remains full-access by default.
- Claude now defaults and invalid-value falls back to `bypassPermissions`.
- Advanced settings retain explicit lower-authority overrides.
