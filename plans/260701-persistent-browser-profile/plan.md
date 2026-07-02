# Persistent Browser Profile Integration

**Status:** In progress

## Decision

Nuncio owns a dedicated persistent Chrome profile. It is not the user's daily
Chrome profile and it is not ephemeral/incognito. Browser cookies, cache,
localStorage, and login sessions persist under the Nuncio data directory so the
web/PWA client can continue the same browser state across launches.

## Scope

1. Add a server-side browser module that launches/controls Chrome through CDP.
2. Store the Chrome user-data-dir under Nuncio data by default.
3. Expose session-scoped browser state, screenshot, navigation, and input APIs.
4. Add a web/PWA browser panel for navigation plus click/type/scroll control.
5. Keep browser screenshots out of the session event log; events may carry only
   lightweight state/version metadata.

## Out Of Scope

- Using the user's personal Chrome profile.
- Agent-facing browser tools.
- High-frame-rate streaming optimization beyond the first interactive slice.

## Success Criteria

- Browser profile path is stable across service restarts.
- Opening a session browser creates or reuses one tab for that Nuncio session.
- Web/PWA can navigate, click, type, scroll, and refresh the visible browser.
- Tests cover persistent profile path and controller/service behavior.

## Unresolved Questions

None.
