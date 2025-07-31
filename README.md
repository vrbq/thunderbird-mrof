# Thunderbird MROF (Move Reply to Original Folder)

> **Move the reply where it belongs – instantly, intelligently … and now with built‑in retries!**

---

## 📥 MROF – Quick Marketplace Install (EN)

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

---

## 🚀 What it does

| UI Element          | Behaviour                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Toolbar button**  | Appears in the message reader toolbar. The tooltip shows the detected destination folder.                                   |
| **Title badge**     | `Thread (N): /path/to/folder` — _N_ is the number of unique `<Message‑ID>` in the thread.                                   |
| **Disabled button** | No folder found yet. If `N ≥ 3`, the button shows **not found — search again** and becomes clickable to force a new lookup. |
| **Click**           | Immediately moves the current message to the detected folder and pops a native notification.                                |

---

## 🆕 What’s new in **v2.2 (2025‑07‑31)**

| Feature               | Description                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Verbose logging**   | Each step of the lookup‑and‑move pipeline reports start/end, cache hits/misses, timings, and results in the console (`[MROF] …`). Ideal for troubleshooting.           |
| **Intelligent retry** | If a thread has **3 or more** unique IDs and the first lookup fails, MROF automatically performs a _second_ lookup in the background.                                  |
| **“Search again” UI** | For large threads still unresolved, the button becomes active with the label **not found — search again**. Clicking it bypasses the cache and performs a fresh lookup. |
| **Stable cache key**  | IDs are now sorted before hashing, preventing duplicate cache entries that could hide a valid folder.                                                                  |
| **Robust move**       | Destination message is now found by `headerMessageId` instead of relying on the (often mutated) _Subject_.                                                             |

---

## ⚙️ How it works (under the hood)

1. **Header scan**   `onMessageDisplayed` fetches only headers → extracts all `<Message‑ID>`‑like tokens.
2. **Thread key**   IDs are de‑duplicated _and sorted_ → stable cache key.
3. **Folder pre‑filter**   All non‑system folders (`!specialUse ∈ [inbox,junk,drafts,sent]`) are cached at start‑up.
4. **Parallel lookup**   Each ID is searched _only_ in those folders. A semaphore keeps a maximum of six concurrent calls.
5. **First hit wins**   `Promise.any` stops as soon as one matching message is located — no wasted queries.
6. **LRU cache (500)**   Thread keys map to either a `MailFolder` or `'not found'` for the whole session.
7. **Retry logic**   If `threadCount ≥ 3` and result is `'not found'`, an automatic silent retry occurs; the button is enabled for manual retry too.
8. **Move**   On click, the current message is moved via `browser.messages.move()` and a notification confirms success.

---

## 🛠️ Feature summary

| Category        | Goodies                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| **Performance** | Folder pre‑filter · semaphore concurrency · idle callbacks · zero UI blocking                           |
| **Reliability** | Stable cache key · robust destination lookup (`headerMessageId`) · optimistic + manual retries          |
| **Compliance**  | `folderId`‑based API (Thunderbird ≥ 128) · minimal permissions (`messages`, `folders`, `notifications`) |
| **Diagnostics** | Rich console logs with timings to ease bug hunting                                                      |

---

## 🧩 Installation (dev‑mode)

```text
1. Thunderbird ≥ 128.0 ESR
2. Tools ▸ Add‑ons ▸ ⚙ ▸ Debug Add‑ons
3. Load Temporary Add‑on → select manifest.json
4. Open any message – the MROF button appears in the reader toolbar
```

---

## 📂 Project layout

```text
mrof/
├── manifest.json        # MV2 declaration & permissions
├── background.js        # Core logic (prefilter, cache, retry, move)
├── icons/
│   └── clippy-256.ico   # Toolbar & notification icon
└── README.md            # This file 💙
```

---

## 🗒️ Changelog

### 2025‑07‑31  • v2.2

- **Verbose logging** across every async step.
- **Automatic & manual retry** for threads with ≥3 messages.
- **“Search again” UI** to re‑run lookup on demand.
- **Stable cache key** fixes rare false negatives.
- **Header‑based move** eliminates subject mismatches.

### 2025‑07‑30  • v2.0

- Folder pre‑filter (non‑system only)
- Pagination support (100 msgs/page)
- `folderId` migration for TB 128+
- LRU cache & semaphore concurrency

---

> _MROF is free/libre software – fork it, hack it, share it!_
