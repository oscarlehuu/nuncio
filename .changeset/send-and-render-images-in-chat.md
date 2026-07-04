---
"nuncio": minor
---

You can now attach images to a chat. The composer — both when steering a running agent and when starting a new one — gains an image button, and you can also paste from the clipboard or drag-and-drop a screenshot straight in. Pasting an image also drops a numbered `[image 1]` reference into the prompt, so you can write around it ("fix the bug in [image 1]") and the agent knows which image you mean. Attached images show as labelled thumbnails before you send and render inline in the transcript afterwards (click to enlarge), alongside any images the agent itself returns. Images are stored on disk and served on demand, so transcripts stay light. The attach control only appears for agents that accept images, so it lights up automatically as each provider gains support — Pi first today.
