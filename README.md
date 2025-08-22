# Thunderbird MROF (Move Reply to Original Folder)

> **Move the reply where it belongs — instantly and intelligently.**

MROF detects the original conversation folder of an incoming message and moves your **reply** there automatically, so your Inbox stays clean and the whole thread lives in one place.

---

## Quick Install (from AMO, _Thunderbird Store_)

1. **Open Thunderbird**.
2. Click the **≡ menu** ▸ **Add-ons and Themes**
3. In the search box, type **MROF** – or jump straight to this
   [page](https://addons.thunderbird.net/thunderbird/addon/mrof-move-rep-original-folder/) :
4. Click **Add to Thunderbird** → **Add**.
5. Open any email; the 📂 **MROF** button is now in the message toolbar.
   _(If it’s hidden, right-click the toolbar ▸ **Customize** and drag it in.)_

Done — auto-filing activated! 🎉

<img src="readMe_image.png" style="width:100%;height:auto;" />

## ✨ Why MROF ?

🎯 MROF eliminates the tedious manual drag‑and‑drop after you hit “Send”. It watches the conversation, finds the first non‑system folder that already contains a message in the thread and moves your reply there, leaving your _Inbox_ spotless.

## Usage

### One-click move

Reply to an email as usual, then click 📂 **MROF** to move the reply to the detected folder.

### Right-click → Re-run detection (ignore cache)

You can now **right-click the MROF button** and choose **Re-run detection (ignore cache)**:

- Clears the cached result **for the current thread**.
- Recomputes the destination using the newest-first scan.
- Shows a small notification when the refresh completes.

This is handy when you just moved some messages and want MROF to re-detect immediately.

## How it works (short version)

- MROF looks at message **headers** (Message-ID, In-Reply-To, References) to reconstruct a set of candidate IDs for the thread.
- It scans the conversation **from newest to oldest** and **stops at the first good folder** that already contains a message from the same thread.
- When you click the MROF button, your **reply** is moved to that folder.

Caching is used to keep things fast; manual refresh is available (see below).

### 🚀 What it does

| UI Element          | Behaviour                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Toolbar button**  | Appears in the message reader toolbar. The tooltip shows the detected destination folder.                                   |
| **Title badge**     | `Thread (N): /path/to/folder` — _N_ is the number of unique `<Message‑ID>` in the thread.                                   |
| **Disabled button** | No folder found yet. If `N ≥ 3`, the button shows **not found — search again** and becomes clickable to force a new lookup. |
| **Click**           | Immediately moves the current message to the detected folder and pops a native notification.                                |

## ⚙️ How it works (under the hood)

1. **Header scan**   `onMessageDisplayed` fetches only headers → extracts all `<Message‑ID>`‑like tokens.
2. **Thread key**   IDs are de‑duplicated _and sorted_ → stable cache key.
3. **Folder pre‑filter**   All non‑system folders (`!specialUse ∈ [inbox,junk,drafts,sent]`) are cached at start‑up.
4. **Parallel lookup**   Each ID is searched _only_ in those folders. A semaphore keeps a maximum of six concurrent calls.
5. **First hit wins**   `Promise.any` stops as soon as one matching message is located — no wasted queries.
6. **LRU cache (500)**   Thread keys map to either a `MailFolder` or `'not found'` for the whole session.
7. **Retry logic**   If `threadCount ≥ 3` and result is `'not found'`, an automatic silent retry occurs; the button is enabled for manual retry too.
8. **Move**   On click, the current message is moved via `browser.messages.move()` and a notification confirms success.

## Notes & Tips

- **Newer-first scan with early exit.** On long threads this speeds up detection and reduces false positives.
- **Header-based detection.** Subject lines are ignored; message IDs are more reliable across languages and clients.
- **Toolbar placement.** If you don’t see the button, right-click the message toolbar → **Customize**.

## Permissions & Privacy

MROF only reads message **headers** and basic folder information required to detect where your **reply** should be filed.  
No network calls; no tracking; nothing leaves Thunderbird.

## 🧩 Installation (dev‑mode)

```text
1. Thunderbird ≥ 128.0 ESR
2. Tools ▸ Add‑ons ▸ ⚙ ▸ Debug Add‑ons
3. Load Temporary Add‑on → select manifest.json
4. Open any message – the MROF button appears in the reader toolbar
```

### 📂 Project layout

```text
mrof/
├── manifest.json        # MV2 declaration & permissions
├── background.js        # Core logic (prefilter, cache, retry, move)
├── icons/
│   └── clippy-256.ico   # Toolbar & notification icon
└── README.md            # This file 💙
```

---

## Troubleshooting

- If detection seems stale after manually reorganizing a thread, **right-click the MROF button** → **Re-run detection (ignore cache)**.
- If the button is disabled on some messages, open the message in the main viewer (not the preview pane) so Thunderbird exposes full context to extensions.
- Report issues with clear steps and, if possible, anonymized header excerpts (Message-ID / In-Reply-To / References).

---

## Changelog

### 2025-08-22 • v6

- **New:** Right-click menu on the MROF toolbar button — **Re-run detection (ignore cache)** for the **current thread**.
- **Improved:** Thread scan order is now **newest → oldest**, with **early stop** on the first valid folder.
- **Dev:** Safer cache invalidation for per-thread entries; clears in-flight lookups before recompute.
- **UX:** Notification after manual refresh to confirm a fresh search ran.

### 2025‑07‑31  • v5

- **Verbose logging** across every async step.
- **Automatic & manual retry** for threads with ≥3 messages.
- **“Search again” UI** to re‑run lookup on demand.
- **Stable cache key** fixes rare false negatives.
- **Header‑based move** eliminates subject mismatches.

### 2025-07-30 • v4

- Folder pre-filter (non-system only)
- Pagination support (100 msgs/page)
- `folderId` migration for TB 128+
- LRU cache & semaphore concurrency

---

_MROF is free/libre software — contributions and forks are welcome._
