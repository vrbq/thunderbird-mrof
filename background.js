// background.js – OPTIMISED v2.2 (2025‑07‑31)
// -----------------------------------------------------------------------------
//  ✅  What’s new (user request 2025‑07‑31):
//  1. Verbose logging everywhere the folder detection pipeline runs.
//  2. When a thread has ≥ 3 unique Message‑IDs, chances are high a folder exists; if
//     the lookup comes back “not found”, we still enable the button and label it
//     “not found — search again”. A click triggers a fresh lookup bypassing the
//     cache so the user can force a retry.
//  3. Same retry path automatically triggered once just after display if the
//     first lookup returned not found while threadCount ≥ 3 (optimistic retry).
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// 🔍 DEBUG switch & helpers
// -----------------------------------------------------------------------------
const DEBUG = false;
const debugLog = (...args) => DEBUG && console.log('[MROF]', ...args);
const benchmark = async (label, asyncFn) => {
  const t0 = performance.now();
  const res = await asyncFn();
  debugLog(`${label} took ${(performance.now() - t0).toFixed(2)} ms`);
  return res;
};

// -----------------------------------------------------------------------------
// 🔧  Utility helpers
// -----------------------------------------------------------------------------
const yieldToEventLoop = () => new Promise((r) => setTimeout(r, 0));
const rqIdle = (cb) =>
  typeof requestIdleCallback === 'function'
    ? requestIdleCallback(cb, { timeout: 1000 })
    : setTimeout(cb, 16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -----------------------------------------------------------------------------
// 🗂️ In‑memory LRU cache   threadKey → MailFolder | 'not found'   (session)
// -----------------------------------------------------------------------------
const MAX_CACHE_SIZE = 500;
/** @type {Map<string, import('webextension-api').MailFolder | 'not found'>} */
const folderCache = new Map();
const setCache = (key, val) => {
  if (folderCache.has(key)) folderCache.delete(key);
  folderCache.set(key, val);
  if (folderCache.size > MAX_CACHE_SIZE)
    folderCache.delete(folderCache.keys().next().value);
};

// -----------------------------------------------------------------------------
// 🏷️ Helpers & constants
// -----------------------------------------------------------------------------
const EXCLUDED_SPECIAL_USE = new Set([
  'inbox',
  'junk',
  'drafts',
  'sent',
]);
const isSystemFolder = (folder) =>
  (folder.specialUse || []).some((id) =>
    EXCLUDED_SPECIAL_USE.has(id)
  );
const MSG_ID_RE = /<[^>]+>/g;
const makeThreadKey = (ids) => ids.slice().sort().join(','); // stable key

// -----------------------------------------------------------------------------
// 📂 Folder pre‑filtering (skip system folders)
// -----------------------------------------------------------------------------
let cachedValidFolders = null; // Promise<MailFolder[]>
const getValidFolders = async () => {
  if (cachedValidFolders) return cachedValidFolders;
  cachedValidFolders = browser.folders
    .query({})
    .then((folders) => folders.filter((f) => !isSystemFolder(f)));
  return cachedValidFolders;
};

// -----------------------------------------------------------------------------
// ⛓️ Concurrency control
// -----------------------------------------------------------------------------
class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise((res) => this.queue.push(res));
    this.active++;
  }
  release() {
    this.active--;
    if (this.queue.length) this.queue.shift()();
  }
}
const sem = new Semaphore(6);
const withSemaphore = async (fn) => {
  await sem.acquire();
  try {
    return await fn();
  } finally {
    sem.release();
  }
};

// -----------------------------------------------------------------------------
// 📑 MessageList helpers (pagination)
// -----------------------------------------------------------------------------
const findInMessageList = async (list, predicate) => {
  let current = list;
  let match = current.messages.find(predicate);
  while (!match && current.id) {
    current = await browser.messages.continueList(current.id);
    match = current.messages.find(predicate);
  }
  return match || null;
};

// -----------------------------------------------------------------------------
// 🔄 Deduplication of ongoing folder lookups per headerMessageId
// -----------------------------------------------------------------------------
/** @type {Map<string, Promise<{folder: import('webextension-api').MailFolder, message: import('webextension-api').MessageHeader}>>} */
const ongoingIdLookups = new Map();
const LOOKUP_TIMEOUT_MS = 5000;

const lookupFolderForMsgId = (id) => {
  if (ongoingIdLookups.has(id)) return ongoingIdLookups.get(id);

  const p = (async () => {
    debugLog(' → lookupFolderForMsgId start', id);
    const result = await Promise.race([
      withSemaphore(async () => {
        const folders = await getValidFolders();
        for (const folder of folders) {
          const list = await browser.messages.query({
            folderId: folder.id,
            headerMessageId: id,
          });
          const hit = await findInMessageList(list, () => true);
          if (hit) {
            debugLog('   ↳ found in', folder.path);
            return { folder, message: hit };
          }
        }
        throw new Error('no‑valid‑folder');
      }),
      sleep(LOOKUP_TIMEOUT_MS).then(() => {
        throw new Error('timeout');
      }),
    ]);
    return result;
  })().finally(() => {
    debugLog(' ← lookupFolderForMsgId end', id);
    ongoingIdLookups.delete(id);
  });

  ongoingIdLookups.set(id, p);
  return p;
};

// -----------------------------------------------------------------------------
// 🌟 findFirstValidFolder(ids) – returns {folder, message}
// -----------------------------------------------------------------------------
async function findFirstValidFolder(uniqueIds) {
  debugLog('findFirstValidFolder() start', { ids: uniqueIds });
  return benchmark('findFirstValidFolder total', async () => {
    try {
      return await Promise.any(uniqueIds.map(lookupFolderForMsgId));
    } catch (_) {
      debugLog('findFirstValidFolder → nothing found');
      return { folder: null, message: null };
    }
  });
}

// -----------------------------------------------------------------------------
// 🏃‍♂️ Core UI helpers
// -----------------------------------------------------------------------------
const setActionTitle = (tabId, threadCount, label) =>
  browser.messageDisplayAction.setTitle({
    title: `Thread (${threadCount}): ${label}`,
  });

const maybeEnableRetryUI = (tabId, threadCount, found) => {
  if (threadCount >= 3 && !found) {
    // Enable button so user can force a retry
    browser.messageDisplayAction.enable(tabId);
    setActionTitle(tabId, threadCount, 'not found — search again');
  }
};

// -----------------------------------------------------------------------------
// 🏃‍♂️ Core processing pipeline
// -----------------------------------------------------------------------------
async function processDisplayedMessage(tab, msgHeader) {
  const t0 = performance.now();
  try {
    await browser.messageDisplayAction.disable(tab.id);
    await setActionTitle(tab.id, 0, 'Loading…');

    // Extract IDs (unique + sorted)
    const { headers } = await browser.messages.getFull(msgHeader.id);
    const raw = `${headers.references?.[0] || ''}${
      headers['In-Reply-To']?.[0] || ''
    }${headers['Message-ID']?.[0] || ''}`;
    const ids = Array.from(
      new Set(raw.match(MSG_ID_RE)?.map((s) => s.slice(1, -1)) || [])
    ).sort();
    const threadKey = makeThreadKey(ids);
    const threadCount = ids.length;

    debugLog('processDisplayedMessage', { threadKey, threadCount });

    const cached = folderCache.get(threadKey);
    if (cached) {
      const label =
        cached === 'not found' ? 'not found' : cached.path;
      await setActionTitle(tab.id, threadCount, label);
      if (cached !== 'not found') {
        await browser.messageDisplayAction.enable(tab.id);
      } else {
        maybeEnableRetryUI(tab.id, threadCount, false);
      }
      debugLog('  ↳ cache hit, done');
      return;
    }

    await new Promise((res) => rqIdle(res));
    debugLog('  ↳ cache miss → lookup');

    const { folder } = await findFirstValidFolder(ids);
    setCache(threadKey, folder || 'not found');

    if (folder) {
      await setActionTitle(tab.id, threadCount, folder.path);
      await browser.messageDisplayAction.enable(tab.id);
    } else {
      debugLog('  ↳ first lookup not found');
      await setActionTitle(tab.id, threadCount, 'not found');
      maybeEnableRetryUI(tab.id, threadCount, false);

      // 🔁 automatic optimistic retry (once)
      if (threadCount >= 3) {
        await yieldToEventLoop();
        debugLog('  ↳ optimistic retry');
        const retry = await findFirstValidFolder(ids);
        if (retry.folder) {
          setCache(threadKey, retry.folder);
          await setActionTitle(
            tab.id,
            threadCount,
            retry.folder.path
          );
          await browser.messageDisplayAction.enable(tab.id);
        }
      }
    }

    debugLog('processDisplayedMessage done', {
      elapsed: (performance.now() - t0).toFixed(2),
    });
  } catch (err) {
    debugLog('Error in processDisplayedMessage', err);
  }
}

// -----------------------------------------------------------------------------
// 1️⃣ Listener: message displayed
// -----------------------------------------------------------------------------
browser.messageDisplay.onMessageDisplayed.addListener(
  (tab, msgHeader) => {
    rqIdle(() => processDisplayedMessage(tab, msgHeader));
  }
);

// -----------------------------------------------------------------------------
// 2️⃣ Listener: toolbar button click
// -----------------------------------------------------------------------------
browser.messageDisplayAction.onClicked.addListener(async (tab) => {
  const startTime = performance.now();
  debugLog('onClicked()', { tabId: tab.id });

  try {
    const displayed =
      await browser.messageDisplay.getDisplayedMessage(tab.id);
    const { headers } = await browser.messages.getFull(displayed.id);
    const raw = `${headers.references?.[0] || ''}${
      headers['In-Reply-To']?.[0] || ''
    }${headers['Message-ID']?.[0] || ''}`;
    const ids = Array.from(
      new Set(raw.match(MSG_ID_RE)?.map((s) => s.slice(1, -1)) || [])
    ).sort();
    const threadKey = makeThreadKey(ids);
    const threadCount = ids.length;

    debugLog('onClicked thread', { threadKey, threadCount });

    let cached = folderCache.get(threadKey);
    let targetFolder = null;
    let destinationMsg = null;

    // Force a fresh lookup if we had "not found" but threadCount ≥ 3
    const mustForce = cached === 'not found' && threadCount >= 3;

    if (!cached || mustForce) {
      debugLog('  ↳ performing (re)lookup');
      const result = await findFirstValidFolder(ids);
      targetFolder = result.folder;
      destinationMsg = result.message;
      setCache(threadKey, targetFolder || 'not found');
    } else if (cached !== 'not found') {
      targetFolder = cached;
      debugLog('  ↳ cache hit (folder)', targetFolder.path);
      // find a message in that folder by headerMessageId (robust)
      for (const mid of ids) {
        const list = await browser.messages.query({
          folderId: targetFolder.id,
          headerMessageId: mid,
        });
        destinationMsg = await findInMessageList(list, () => true);
        if (destinationMsg) break;
      }
    }

    if (!destinationMsg) throw new Error('No valid folder found');

    await browser.messages.move([displayed.id], targetFolder.id);
    await browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/clippy-256.ico'),
      title: 'Message moved',
      message: `Moved to: ${targetFolder.path}`,
    });
  } catch (err) {
    debugLog('onClicked() error', err);
    await browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/clippy-256.ico'),
      title: 'Error',
      message: err.message,
    });
  } finally {
    debugLog('onClicked() end', {
      elapsed: (performance.now() - startTime).toFixed(2),
    });
  }
});
