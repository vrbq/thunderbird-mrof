/* manifest.json is unchanged (already fully in English) */

// background.js
// PERFORMANCE‑OPTIMISED VERSION
// -----------------------------------------------------------------------------
// Goals
// 1. Avoid blocking the UI (no freezes) by yielding control and parallelising.
// 2. Minimise Thunderbird API traffic by caching previous look‑ups.
// 3. Stop work as soon as a valid folder is discovered (early resolve).
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// 🔧 Utility: Pause to yield back to the event loop (keeps UI responsive)
// -----------------------------------------------------------------------------
const yieldToEventLoop = () =>
  new Promise((resolve) => setTimeout(resolve, 0));

// -----------------------------------------------------------------------------
// 🗂️ In‑memory cache: threadKey  →  folderPath
// A threadKey is simply the sorted list of Message‑IDs joined by ','
// Lifespan is the session; Thunderbird restarts clear it (good enough).
// -----------------------------------------------------------------------------
const folderCache = new Map();

// -----------------------------------------------------------------------------
// 🏷️ Helper: derive a stable cache key from an array of IDs
// -----------------------------------------------------------------------------
const makeThreadKey = (ids) => ids.slice().sort().join(',');

// -----------------------------------------------------------------------------
// 🌟 Helper: findFirstValidFolder(ids) → returns {folderPath, message}
// Uses Promise.any so the FIRST fulfilled lookup wins; rejected promises are
// ignored. This stops waiting for slower queries after a folder is found.
// -----------------------------------------------------------------------------
async function findFirstValidFolder(messageIds) {
  // Prepare one query‑promise per ID
  const lookupPromises = messageIds.map((id) =>
    (async () => {
      const { messages } = await browser.messages.query({
        headerMessageId: id,
      });
      const hit = messages.find(
        (m) => !/(inbox|spam|drafts?|sent)/i.test(m.folder.path)
      );
      if (hit) return { folderPath: hit.folder.path, message: hit };
      // If no hit, throw so Promise.any ignores it
      throw new Error('no‑valid‑folder');
    })()
  );

  // If every promise rejects, Promise.any throws an AggregateError
  try {
    return await Promise.any(lookupPromises);
  } catch {
    return { folderPath: 'not found', message: null };
  }
}

// -----------------------------------------------------------------------------
// 1️⃣ Listener: when a message is displayed.
// -----------------------------------------------------------------------------
browser.messageDisplay.onMessageDisplayed.addListener(
  (tab, msgHeader) => {
    // QUICK: immediately show loading state and disable button (non‑blocking)
    browser.messageDisplayAction.setTitle({ title: 'Loading…' });
    browser.messageDisplayAction.disable(tab.id);

    // DEFER: run heavy work asynchronously without blocking the handler
    (async () => {
      try {
        // Extract IDs (same logic as before)
        const { headers } = await browser.messages.getFull(
          msgHeader.id
        );
        const raw =
          (headers.references?.[0] || '') +
          (headers['In-Reply-To']?.[0] || '') +
          (headers['Message-ID']?.[0] || '');
        const ids = (raw.match(/<[^>]+>/g) || []).map((s) =>
          s.slice(1, -1)
        );
        const threadKey = makeThreadKey(ids);
        const threadCount = ids.length;

        // Cache check: if cached, update UI and exit
        if (folderCache.has(threadKey)) {
          const cachedFolder = folderCache.get(threadKey);
          browser.messageDisplayAction.setTitle({
            title: `Thread (${threadCount}): ${cachedFolder}`,
          });
          if (cachedFolder !== 'not found')
            browser.messageDisplayAction.enable(tab.id);
          return;
        }

        // Lookup in idle time to avoid UI contention
        await yieldToEventLoop();
        const { folderPath } = await findFirstValidFolder(ids);
        folderCache.set(threadKey, folderPath);

        // Final UI update once resolved
        browser.messageDisplayAction.setTitle({
          title: `Thread (${threadCount}): ${folderPath}`,
        });
        if (folderPath !== 'not found')
          browser.messageDisplayAction.enable(tab.id);
      } catch {
        // On any error, keep button disabled and title as is
      }
    })(); // end of async IIFE
  }
);

// -----------------------------------------------------------------------------
browser.messageDisplay.onMessageDisplayed.addListener(
  async (tab, msgHeader) => {
    await browser.messageDisplayAction.setTitle({
      title: 'Loading…',
    });

    try {
      // --- Extract thread IDs ----------------------------------------------------
      const { headers } = await browser.messages.getFull(
        msgHeader.id
      );
      const raw =
        (headers.references?.[0] || '') +
        (headers['In-Reply-To']?.[0] || '') +
        (headers['Message-ID']?.[0] || '');
      const ids = (raw.match(/<[^>]+>/g) || []).map((s) =>
        s.slice(1, -1)
      );
      const threadKey = makeThreadKey(ids);
      const threadCount = ids.length;

      // --- QUICK PATH: check cache ----------------------------------------------
      if (folderCache.has(threadKey)) {
        const cachedFolder = folderCache.get(threadKey);
        await browser.messageDisplayAction.setTitle({
          title: `Thread (${threadCount}): ${cachedFolder}`,
        });
        if (cachedFolder === 'not found') {
          await browser.messageDisplayAction.disable(tab.id);
        } else {
          await browser.messageDisplayAction.enable(tab.id);
        }
        return; // Done, no freeze
      }

      // --- SLOW PATH: parallel lookup -------------------------------------------
      await yieldToEventLoop(); // Let UI breathe before heavy work
      const { folderPath } = await findFirstValidFolder(ids);

      // Cache result for future hits in this session
      folderCache.set(threadKey, folderPath);

      // Update UI based on lookup
      await browser.messageDisplayAction.setTitle({
        title: `Thread (${threadCount}): ${folderPath}`,
      });
      if (folderPath === 'not found') {
        await browser.messageDisplayAction.disable(tab.id);
      } else {
        await browser.messageDisplayAction.enable(tab.id);
      }
    } catch (err) {
      // Any failure → disable button to stay safe
      await browser.messageDisplayAction.disable(tab.id);
    }
  }
);

// -----------------------------------------------------------------------------
// 2️⃣ Listener: when the toolbar button is clicked.
// -----------------------------------------------------------------------------
browser.messageDisplayAction.onClicked.addListener(async (tab) => {
  try {
    const displayed =
      await browser.messageDisplay.getDisplayedMessage(tab.id);
    const { headers } = await browser.messages.getFull(displayed.id);
    const raw =
      (headers.references?.[0] || '') +
      (headers['In-Reply-To']?.[0] || '') +
      (headers['Message-ID']?.[0] || '');
    const ids = (raw.match(/<[^>]+>/g) || []).map((s) =>
      s.slice(1, -1)
    );
    const threadKey = makeThreadKey(ids);

    // --- Use cache first -------------------------------------------------------
    let folderPath = folderCache.get(threadKey) || null;
    let destinationMsg = null;

    // If not cached or cached as 'not found', do fresh lookup
    if (!folderPath || folderPath === 'not found') {
      await yieldToEventLoop(); // yield before heavy work
      const result = await findFirstValidFolder(ids);
      folderPath = result.folderPath;
      destinationMsg = result.message;
      folderCache.set(threadKey, folderPath); // update cache
    } else {
      // We have folder path; still need a message object for move()
      const { messages } = await browser.messages.query({
        folder: folderPath,
        subject: displayed.subject,
      });
      destinationMsg = messages[0] || null; // best‑effort
    }

    if (!destinationMsg)
      throw new Error('No valid folder found for moving');

    // --- Move the message ------------------------------------------------------
    await browser.messages.move(
      [displayed.id],
      destinationMsg.folder
    );

    // --- Notify success --------------------------------------------------------
    await browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon-48.png'),
      title: 'Message moved',
      message: `Moved to: ${folderPath}`,
    });
  } catch (err) {
    // --- Notify failure --------------------------------------------------------
    await browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon-48.png'),
      title: 'Error moving message',
      message: err.message,
    });
  }
});
