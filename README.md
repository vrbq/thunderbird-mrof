# Thunderbird MROF (Move Reply to Original Folder)

> **Move the reply where it belongs – instantly and intelligently.**

---

## ✨ Why should you use MROF ?

**Alice :** “I keep dragging every sent reply back into my project folders… It’s 2025, why isn’t this automatic? 😩”

**Bob :** “Just install **MROF**! One click and the message jumps straight to the folder of the original conversation. 🪄📬”

![Demo banner](readMe_image.png)

---

## 🚀 What it does

- Adds a **toolbar button** in the message view.
- Shows the label `Thread (N): /path/to/folder` while you read.

  - **N** = number of messages detected in the conversation.
  - _Folder_ = the first location **outside inbox / junk / drafts / sent** (detected via Thunderbird *specialUse* flags).

- **One click** moves the current message there.
- Button is **greyed‑out** when no suitable folder exists.

---

## ⚙️ How it works (2025‑07‑30 build)

| Step | Optimised logic                                                                                                                                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|  1   | **Header scan** – `background.js` receives `messageDisplay.onMessageDisplayed`, fetches only the headers, extracts `<Message‑ID>` / `References`, builds a unique **threadKey**.                                                          |
|  2   | **Folder pre‑filter** – calls `browser.folders.query()` **once** per session, caching all folders whose `specialUse` _is not_ `inbox`, `junk`, `drafts`, or `sent`.                                                                       |
|  3   | **Target lookup** – for each ID, queries **only those valid folders** via `browser.messages.query({ folderId, headerMessageId })`, paginates (`MessageList.continueList`) and stops at the **first hit** (parallelised with a semaphore). |
|  4   | **Caching** – stores `threadKey → MailFolder` in a session LRU (500 threads). Subsequent visits are instant.                                                                                                                              |
|  5   | **UI update** – updates the button title and enables/disables it without blocking the main thread.                                                                                                                                        |
|  6   | **Move** – on click, calls `browser.messages.move([msgId], targetFolder.id)` and shows a native notification.                                                                                                                             |

---

## 🛠️ Key Features

|  Feature                  | Details                                                                     |
| ------------------------- | --------------------------------------------------------------------------- |
| **Folder pre‑filter**     | Skips whole system folders up‑front, reducing API traffic and latency.      |
| **Pagination support**    | Handles Thunderbird’s 100‑message pages transparently.                      |
| **`folderId` everywhere** | All API calls now use `folderId` rather than paths for TB ≥ 128 compliance. |
| **LRU cache (500)**       | Stores the actual `MailFolder` object for instant repeats and ID access.    |
| **Semaphore concurrency** | Limits concurrent lookups (default 6) to keep TB responsive.                |
| **Non‑blocking UI**       | Heavy work scheduled in idle time; quick visual feedback.                   |
| **Minimal permissions**   | Only `messages`, `folders`, `notifications`, and `messageDisplayAction`.    |
| **Tested**                | Thunderbird 128‑esr → 140.1 (Win / Linux).                                  |

---

## 🧩 Installation (Developer mode)

1. Thunderbird ≥ 128.0 ESR.
2. **Tools ▸ Add‑ons ▸ ⚙ ▸ Debug Add‑ons**.
3. **Load Temporary Add‑on** → select `manifest.json`.
4. Open any message – the **MROF** button appears in the reader toolbar.

---

## 🎮 Usage cheatsheet

| Button state    | Meaning                             |
| --------------- | ----------------------------------- |
| 🟢 **Active**   | Valid folder found – click to move. |
| ⚪ **Disabled** | No folder available or error.       |

---

## 📂 Project layout

```plaintext
mrof/
├── manifest.json        # Declares MV2, permissions, message_display_action
├── background.js        # Core logic (prefilter, cache, move)
├── icons/
│   └── clippy-256.ico   # Toolbar & notification icon
└── README.md            # You are here ❤️
```

---

## 🗒️ Recent changes (2025‑07‑30)

- **Folder pre‑filter** via `browser.folders.query()` → cuts message queries by 80 %.
- **System‑folder detection** now uses `folder.specialUse` (not names).
- **Pagination** support for `MessageList` (100 messages / page).
- **`folderId`** replaces folder paths in all API calls.
- **Full TypeScript‑style JSDoc** and richer inline comments for maintainability.

---

> _MROF is free software – tweak it, fork it, and make email a little smarter!_
