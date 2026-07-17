---
"nuncio": minor
---

Retuned the web UI to Cursor's exact design tokens. Dark mode now uses Cursor's two-neutral system — #141414 chrome (sidebar, panels, menus) and #181818 content (transcript, cards, tiles) — with #F0F0F0 text and a single foreground alpha ramp driving every border, hover, and selection tone. Light mode mirrors it with #FCFCFC content, #F3F3F3 chrome, and #141414 ink. Color now appears only for state (green success, red error, amber warning, and the diff washes); everything else stays strictly monochrome, corners tighten to a 4px radius scale, and real shadows are reserved for floating menus and dialogs.
