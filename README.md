# Thunderbird MROF (Move Reply to Original Folder)

## Why should you use MROF ?

**Alice:** “Ugh, I feel like Indiana Jones searching through my own folders for sorting replies! 😩🗃️”  
**Bob:** “Fear not—Thunderbird MROF is here! 🚀 It magically spots the right thread and teleports your email into the correct folder. No more treasure hunts! 🧙‍♂️✨”  
**Alice:** “Teleportation? Sounds like wizardry! 🔮 How do I activate it?”  
**Bob:** “Just click the button—bam! Your message is whisked away to its proper home. No more folder fiascos! 🎉📥”

<img src="readMe_image.png" style="width:100%;height:auto;" />

## How does it works ?

> **Function:** A button added to the message-view toolbar displays:
>
> ```
> Thread (N): /path/to/folder
> ```
>
> – **N** is the number of messages detected in the conversation
> – The folder is that of the first message **outside** Inbox/Spam/Drafts/Sent
>
> A single click immediately moves the displayed message into that folder.
> The button is disabled (greyed out) if no valid folder is found.

---

## How It Works

1. **Detection:** `background.js` intercepts `messageDisplay.onMessageDisplayed`, fetches only the headers with `messages.getRaw`, extracts all `<Message-ID>`s, and counts them as `threadCount`.
2. **Lookup:** For each ID, a `messages.query({ headerMessageId })` request is issued in parallel; the first result whose folder path is not Inbox/Spam/Drafts/Sent is selected.
3. **Update:** The button title becomes `Thread (N): folder`. If no valid folder is found, the button is disabled via `messageDisplayAction.disable`.
4. **Popup (legacy):** If `default_popup` is defined in `manifest.json`, `popup.js` provides a manual confirmation before moving.
5. **Move:** On click, `background.js` (or `popup.js` if confirmation is used) calls `messages.move()` and shows a native success notification.

### Features

| Feature                         | Details                                                                                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message_display_action` button | Appears in the message-view toolbar ([MDN messageDisplayAction](https://webextension-api.thunderbird.net/en/stable/messageDisplayAction.html)).                                                                                                                     |
| Quick thread detection          | Minimal header reads via [`browser.messages.getRaw`](https://webextension-api.thunderbird.net/en/stable/messages.html#getraw-messageid-options); extracts `Message-ID` and `References`.                                                                            |
| Fast folder lookup              | Parallel queries using [`browser.messages.query`](https://webextension-api.thunderbird.net/en/stable/messages.html#query-queryinfo); short‑circuits as soon as a valid folder is found.                                                                             |
| In-memory cache                 | A session‑long map `threadKey → folderPath` avoids repeated lookups for the same thread.                                                                                                                                                                            |
| Dynamic enable/disable          | Button activation via [`browser.messageDisplayAction.enable`](https://webextension-api.thunderbird.net/en/stable/messageDisplayAction.html#enable-tabid) / [`disable`](https://webextension-api.thunderbird.net/en/stable/messageDisplayAction.html#disable-tabid). |
| Instant move                    | Moves via [`browser.messages.move`](https://webextension-api.thunderbird.net/en/stable/messages.html#move-messageids-folderid) and then displays a native success notification.                                                                                     |
| Compatibility                   | Tested on 140.1.0esr (64 bits)                                                                                                                                                                                                                                      |

---

## Installation (Developer Mode)

1. Open Thunderbird ≥ 115 ESR.
2. **Tools → Add-ons → ⚙ → Debug Add-ons**.
3. **Load Temporary Add-on** and select `manifest.json`.
4. Open any message to see the new button in the toolbar.

---

## Usage

| Button State    | Meaning                                                                        |
| --------------- | ------------------------------------------------------------------------------ |
| 🟢 **Active**   | A valid target folder was found; clicking moves the message.                   |
| ⚪ **Disabled** | No valid folder found (or an error occurred); the message remains where it is. |

---

## Project Files

| File            | Role                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------- |
| `manifest.json` | Declares MV2, defines the `message_display_action`, and lists minimal required permissions. |
| `background.js` | Calculates thread info, manages cache, updates and toggles the button, performs the move.   |
| `icons/`        | Contains a 256 × 256 icon (`clippy-256.ico`) used in toolbar and notifications.             |

### Directory Structure

```plaintext
move-reply/
├── manifest.json
├── background.js
├── icons/
│   └── clippy-256.ico
```

---

## Development & Debugging

Use **Inspect** in the _Debug Add-ons_ page to open the background and popup consoles for real-time logs and inspection.

---

## Recent Enhancements (Integrated by \[Your Name])

- **Detailed Inline Comments**: Added explanatory comments for every variable, action, and decision point in `background.js` to aid code review and future maintenance.
- **Performance Optimizations**:

  - **In-memory Caching** (`folderCache`) to avoid redundant folder lookups within a session.
  - **Parallel Folder Queries** using `Promise.any` for early resolution and reduced wait time.
  - **Non-blocking UI** by deferring heavy work in an async IIFE (for message display) and yielding control via `setTimeout(0)`.
  - **Quick Disable/Enable**: Immediately reflects loading and valid-folder states without blocking the Thunderbird UI.

_These enhancements dramatically reduce UI freezes and make the extension more responsive under typical usage._
