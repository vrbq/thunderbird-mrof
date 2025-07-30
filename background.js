// background.js – OPTIMISED 2025‑07‑30
// -----------------------------------------------------------------------------
// This refactor focuses on three main axes (as requested):
// 2️⃣ Reducing Thunderbird API traffic
// 3️⃣ Scheduling / concurrency control to keep the UI fully non‑blocking
// 4️⃣ Algorithms & data structures optimisation
// -----------------------------------------------------------------------------
//  ⚠️  All public behaviour remains unchanged (same UI, same notifications)
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// 🔍 DEBUG switch & helpers
// -----------------------------------------------------------------------------
const DEBUG = false;
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

// requestIdleCallback polyfill (background pages don’t always have it)
const rqIdle = (cb) =>
  typeof requestIdleCallback === 'function'
    ? requestIdleCallback(cb, { timeout: 1000 })
    : setTimeout(cb, 16);

// Sleep helper (for timeout race)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -----------------------------------------------------------------------------
// 🗂️  In‑memory LRU cache   threadKey → folderPath   (session‑scoped)
// -----------------------------------------------------------------------------
const MAX_CACHE_SIZE = 500;
const folderCache = new Map(); // insertion‑order Map acts as LRU when pruned
const setCache = (key, val) => {
  if (folderCache.has(key)) folderCache.delete(key); // refresh position
  folderCache.set(key, val);
  if (folderCache.size > MAX_CACHE_SIZE) {
    const oldestKey = folderCache.keys().next().value;
    folderCache.delete(oldestKey);
  }
};

// -----------------------------------------------------------------------------
// 🏷️  Helpers & constants
// -----------------------------------------------------------------------------
const SYSTEM_FOLDER_RE = /(inbox|spam|drafts?|sent)/i;
const MSG_ID_RE = /<[^>]+>/g; // pre‑compiled once

const makeThreadKey = (ids) => ids.join(','); // IDs are already unique & sorted

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

// Wrap any async fn with semaphore
const withSemaphore = async (fn) => {
  await sem.acquire();
  try {
    return await fn();
  } finally {
    sem.release();
  }
};

// -----------------------------------------------------------------------------
// 🔄  Deduplication of ongoing folder lookups per headerMessageId
// -----------------------------------------------------------------------------
const ongoingIdLookups = new Map(); // id → Promise<{folderPath,message}>
const LOOKUP_TIMEOUT_MS = 5000;

const lookupFolderForMsgId = (id) => {
  if (ongoingIdLookups.has(id)) return ongoingIdLookups.get(id);

  const p = (async () => {
    // Race against a timeout to avoid hanging forever
    const result = await Promise.race([
      withSemaphore(async () => {
        const { messages } = await browser.messages.query({
          headerMessageId: id,
        });
        const hit = messages.find(
          (m) => !SYSTEM_FOLDER_RE.test(m.folder.path)
        );
        if (!hit) throw new Error('no‑valid‑folder');
        return { folderPath: hit.folder.path, message: hit };
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
// 🌟  findFirstValidFolder(ids) – returns {folderPath, message}
// -----------------------------------------------------------------------------
async function findFirstValidFolder(uniqueIds) {
  debugLog('findFirstValidFolder() start', {
    count: uniqueIds.length,
  });
  return benchmark('findFirstValidFolder total', async () => {
    try {
      return await Promise.any(uniqueIds.map(lookupFolderForMsgId));
    } catch (_) {
      return { folderPath: 'not found', message: null };
    }
  });
}

// -----------------------------------------------------------------------------
// 🏃‍♂️  Core processing pipeline (non‑blocking wrapper)
// -----------------------------------------------------------------------------
async function processDisplayedMessage(tab, msgHeader) {
  const innerStart = performance.now();
  try {
    // 1. Quick UI feedback
    browser.messageDisplayAction.setTitle({ title: 'Loading…' });
    browser.messageDisplayAction.disable(tab.id);

    // 2. Extract / cache headers
    const { headers } = await browser.messages.getFull(msgHeader.id);
    const raw = `${headers.references?.[0] || ''}${
      headers['In-Reply-To']?.[0] || ''
    }${headers['Message-ID']?.[0] || ''}`;

    // Use Set to deduplicate without costly sort
    const ids = [
      ...new Set(
        raw.match(MSG_ID_RE)?.map((s) => s.slice(1, -1)) || []
      ),
    ];
    const threadKey = makeThreadKey(ids);
    const threadCount = ids.length;

    // 3. Fast‑path: cache hit
    if (folderCache.has(threadKey)) {
      const cachedFolder = folderCache.get(threadKey);
      browser.messageDisplayAction.setTitle({
        title: `Thread (${threadCount}): ${cachedFolder}`,
      });
      if (cachedFolder !== 'not found')
        browser.messageDisplayAction.enable(tab.id);
      debugLog('processDisplayedMessage: cache hit', {
        threadKey,
        elapsed: (performance.now() - innerStart).toFixed(2),
      });
      return;
    }

    // 4. Heavy work scheduled during idle time
    await new Promise((res) => rqIdle(res));
    debugLog('Starting folder lookup', { threadKey });

    const { folderPath } = await findFirstValidFolder(ids);
    setCache(threadKey, folderPath);

    // 5. Final UI update
    browser.messageDisplayAction.setTitle({
      title: `Thread (${threadCount}): ${folderPath}`,
    });
    if (folderPath !== 'not found')
      browser.messageDisplayAction.enable(tab.id);

    debugLog('processDisplayedMessage completed', {
      threadKey,
      folderPath,
      elapsed: (performance.now() - innerStart).toFixed(2),
    });
  } catch (err) {
    debugLog('Error in processDisplayedMessage', err);
  }
}

// -----------------------------------------------------------------------------
// 1️⃣  Listener: message displayed (single, optimised)
// -----------------------------------------------------------------------------
browser.messageDisplay.onMessageDisplayed.addListener(
  (tab, msgHeader) => {
    // Minimal synchronous work → schedule async pipeline
    rqIdle(() => processDisplayedMessage(tab, msgHeader));
  }
);

// -----------------------------------------------------------------------------
// 2️⃣  Listener: toolbar button click (move message)
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

    let folderPath = folderCache.get(threadKey) || null;
    let destinationMsg = null;

    if (!folderPath || folderPath === 'not found') {
      await yieldToEventLoop();
      debugLog('Cache miss → lookup', { threadKey });
      const result = await findFirstValidFolder(ids);
      folderPath = result.folderPath;
      destinationMsg = result.message;
      setCache(threadKey, folderPath);
    } else {
      debugLog('Cache hit for move', { threadKey, folderPath });
      const { messages } = await browser.messages.query({
        folder: folderPath,
        subject: displayed.subject,
      });
      destinationMsg = messages[0] || null;
    }

    if (!destinationMsg)
      throw new Error('No valid folder found for moving');

    await browser.messages.move(
      [displayed.id],
      destinationMsg.folder
    );

    await browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/clippy-256.ico'),
      title: 'Message moved',
      message: `Moved to: ${folderPath}`,
    });
    debugLog('Move successful', { folderPath });
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
