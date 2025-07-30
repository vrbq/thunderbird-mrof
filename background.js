// background.js – OPTIMISED 2025‑07‑30 (folder‑prefilter migration 2025‑07‑30)
// -----------------------------------------------------------------------------
// This refactor focuses on three main axes (as requested):
// 2️⃣ Reducing Thunderbird API traffic
// 3️⃣ Scheduling / concurrency control to keep the UI fully non‑blocking
// 4️⃣ Algorithms & data structures optimisation
// -----------------------------------------------------------------------------
//  ⚠️  All public behaviour remains unchanged (same UI, same notifications)
//  ⚙️  2025‑07‑30: Updated to Thunderbird 128+ API (folderId instead of folder path)
//  🆕  2025‑07‑30: Replaced path‑based system‑folder detection with specialUse[] check
//  🆕  2025‑07‑30: Added MessageList pagination handling (max 100 msgs/page)
//  🆕  2025‑07‑30: **Folder pre‑filter** – messages are now searched **only** in non‑system folders, using `browser.folders.query()`
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// 🔍 DEBUG switch & helpers
// -----------------------------------------------------------------------------
const DEBUG = true;
const debugLog = (...args) => DEBUG && console.log('[MROF]', ...args);
const benchmark = async (label, asyncFn) => {
  const t0 = performance.now();
  const res = await asyncFn();
  debugLog(`${label} took ${(performance.now() - t0).toFixed(2)} ms`);
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
// 🗂️  In‑memory LRU cache   threadKey → MailFolder | 'not found'   (session)
// -----------------------------------------------------------------------------
const MAX_CACHE_SIZE = 500;
/** @type {Map<string, import('webextension-api').MailFolder | 'not found'>} */
const folderCache = new Map();
const setCache = (key, val) => {
  if (folderCache.has(key)) folderCache.delete(key);
  folderCache.set(key, val);
  if (folderCache.size > MAX_CACHE_SIZE) {
    const oldestKey = folderCache.keys().next().value;
    folderCache.delete(oldestKey);
  }
};

// -----------------------------------------------------------------------------
// 🏷️  Helpers & constants
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
const makeThreadKey = (ids) => ids.join(',');

// -----------------------------------------------------------------------------
// 📂  Folder pre‑filtering (skip system folders)
// -----------------------------------------------------------------------------
let cachedValidFolders = null; // Promise<MailFolder[]>
/**
 * Return all non‑system folders once (cached).
 * @returns {Promise<import('webextension-api').MailFolder[]>}
 */
const getValidFolders = async () => {
  if (cachedValidFolders) return cachedValidFolders;
  cachedValidFolders = browser.folders
    .query({})
    .then((folders) => folders.filter((f) => !isSystemFolder(f)));
  return cachedValidFolders;
};

// -----------------------------------------------------------------------------
// ⛓️  Concurrency control
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
const MAX_PARALLEL_LOOKUPS = 6;
const sem = new Semaphore(MAX_PARALLEL_LOOKUPS);
const withSemaphore = async (fn) => {
  await sem.acquire();
  try {
    return await fn();
  } finally {
    sem.release();
  }
};

// -----------------------------------------------------------------------------
// 📑  MessageList helpers (pagination)
// -----------------------------------------------------------------------------
/**
 * Walk through a MessageList until `predicate` matches or end.
 */
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
// 🔄  Deduplication of ongoing folder lookups per headerMessageId
// -----------------------------------------------------------------------------
/** @type {Map<string, Promise<{folder: import('webextension-api').MailFolder, message: import('webextension-api').MessageHeader}>>} */
const ongoingIdLookups = new Map();
const LOOKUP_TIMEOUT_MS = 5000;

const lookupFolderForMsgId = (id) => {
  if (ongoingIdLookups.has(id)) return ongoingIdLookups.get(id);

  const p = (async () => {
    const result = await Promise.race([
      withSemaphore(async () => {
        const folders = await getValidFolders(); // 🆕 only non‑system folders
        for (const folder of folders) {
          const list = await browser.messages.query({
            folderId: folder.id,
            headerMessageId: id,
          });
          const hit = await findInMessageList(list, () => true); // headerMessageId already filters
          if (hit) return { folder, message: hit };
        }
        throw new Error('no‑valid‑folder');
      }),
      sleep(LOOKUP_TIMEOUT_MS).then(() => {
        throw new Error('timeout');
      }),
    ]);
    return result;
  })().finally(() => ongoingIdLookups.delete(id));

  ongoingIdLookups.set(id, p);
  return p;
};

// -----------------------------------------------------------------------------
// 🌟  findFirstValidFolder(ids) – returns {folder, message}
// -----------------------------------------------------------------------------
async function findFirstValidFolder(uniqueIds) {
  debugLog('findFirstValidFolder() start', {
    count: uniqueIds.length,
  });
  return benchmark('findFirstValidFolder total', async () => {
    try {
      return await Promise.any(uniqueIds.map(lookupFolderForMsgId));
    } catch (_) {
      return { folder: null, message: null };
    }
  });
}

// -----------------------------------------------------------------------------
// 🏃‍♂️  Core processing pipeline
// -----------------------------------------------------------------------------
async function processDisplayedMessage(tab, msgHeader) {
  const innerStart = performance.now();
  try {
    browser.messageDisplayAction.setTitle({ title: 'Loading…' });
    browser.messageDisplayAction.disable(tab.id);

    const { headers } = await browser.messages.getFull(msgHeader.id);
    const raw = `${headers.references?.[0] || ''}${
      headers['In-Reply-To']?.[0] || ''
    }${headers['Message-ID']?.[0] || ''}`;
    const ids = [
      ...new Set(
        raw.match(MSG_ID_RE)?.map((s) => s.slice(1, -1)) || []
      ),
    ];
    const threadKey = makeThreadKey(ids);
    const threadCount = ids.length;

    const cached = folderCache.get(threadKey);
    if (cached) {
      const label =
        cached === 'not found' ? 'not found' : cached.path;
      browser.messageDisplayAction.setTitle({
        title: `Thread (${threadCount}): ${label}`,
      });
      if (cached !== 'not found')
        browser.messageDisplayAction.enable(tab.id);
      debugLog('processDisplayedMessage: cache hit', {
        threadKey,
        elapsed: (performance.now() - innerStart).toFixed(2),
      });
      return;
    }

    await new Promise((res) => rqIdle(res));
    debugLog('Starting folder lookup', { threadKey });

    const { folder } = await findFirstValidFolder(ids);
    setCache(threadKey, folder || 'not found');

    const label = folder ? folder.path : 'not found';
    browser.messageDisplayAction.setTitle({
      title: `Thread (${threadCount}): ${label}`,
    });
    if (folder) browser.messageDisplayAction.enable(tab.id);

    debugLog('processDisplayedMessage completed', {
      threadKey,
      folderPath: label,
      elapsed: (performance.now() - innerStart).toFixed(2),
    });
  } catch (err) {
    debugLog('Error in processDisplayedMessage', err);
  }
}

// -----------------------------------------------------------------------------
// 1️⃣  Listener: message displayed
// -----------------------------------------------------------------------------
browser.messageDisplay.onMessageDisplayed.addListener(
  (tab, msgHeader) => {
    rqIdle(() => processDisplayedMessage(tab, msgHeader));
  }
);

// -----------------------------------------------------------------------------
// 2️⃣  Listener: toolbar button click
// -----------------------------------------------------------------------------
browser.messageDisplayAction.onClicked.addListener(async (tab) => {
  const startTime = performance.now();
  debugLog('onClicked() invoked', { tabId: tab.id });

  try {
    const displayed =
      await browser.messageDisplay.getDisplayedMessage(tab.id);
    const { headers } = await browser.messages.getFull(displayed.id);
    const raw = `${headers.references?.[0] || ''}${
      headers['In-Reply-To']?.[0] || ''
    }${headers['Message-ID']?.[0] || ''}`;
    const ids = [
      ...new Set(
        raw.match(MSG_ID_RE)?.map((s) => s.slice(1, -1)) || []
      ),
    ];
    const threadKey = makeThreadKey(ids);

    let cached = folderCache.get(threadKey);
    let targetFolder = null;
    let destinationMsg = null;

    if (!cached || cached === 'not found') {
      await yieldToEventLoop();
      debugLog('Cache miss → lookup', { threadKey });
      const result = await findFirstValidFolder(ids);
      targetFolder = result.folder;
      destinationMsg = result.message;
      setCache(threadKey, targetFolder || 'not found');
    } else {
      targetFolder = cached;
      debugLog('Cache hit for move', {
        threadKey,
        folderPath: targetFolder.path,
      });
      const list = await browser.messages.query({
        folderId: targetFolder.id,
        subject: displayed.subject,
      }); // 🆕 paginated
      destinationMsg = await findInMessageList(list, () => true); // 🆕 first msg in thread
    }

    if (!destinationMsg)
      throw new Error('No valid folder found for moving');

    await browser.messages.move([displayed.id], targetFolder.id);

    await browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/clippy-256.ico'),
      title: 'Message moved',
      message: `Moved to: ${targetFolder.path}`,
    });
    debugLog('Move successful', { folderPath: targetFolder.path });
  } catch (err) {
    debugLog('Error in onClicked()', err);
    await browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/clippy-256.ico'),
      title: 'Error moving message',
      message: err.message,
    });
  } finally {
    debugLog(
      `onClicked() completed in ${(
        performance.now() - startTime
      ).toFixed(2)} ms`
    );
  }
});
