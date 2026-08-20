# Trajectory Editor

A dependency-free, offline trajectory viewer and editor.

## Run locally

Open `index.html` directly in a modern browser, or run a local server:

```bash
python3 -m http.server 8080
```

Then visit `http://localhost:8080`.

Upload the original trajectory on the left and the edited trajectory on the right. The app supports JSON objects, JSON arrays, JSONL, concatenated JSON objects, and downloaded trajectory exports containing keyed `steps`. Export metadata is preserved when an edited wrapped trajectory is downloaded. All processing stays in the browser.

Manual edits are stored as local drafts on every keystroke, including temporarily invalid JSON. Dirty sections are highlighted and available through the Dirty jumper. Invalid drafts must be corrected or reset before downloading the edited trajectory.
