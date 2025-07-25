// background.js
// Gestion des événements de Thunderbird pour afficher et déplacer le message

// 1. À chaque affichage de message, on calcule et on met à jour le titre sans logs
browser.messageDisplay.onMessageDisplayed.addListener(
  async (tab, msgHdr) => {
    // État initial
    await browser.messageDisplayAction.setTitle({
      title: 'Chargement…',
    });

    try {
      // Récupère d’un seul coup le full header
      const { headers } = await browser.messages.getFull(msgHdr.id);

      // Extrait tous les Message-ID du fil en une seule passe
      const raw =
        (headers.references?.[0] || '') +
        (headers['In-Reply-To']?.[0] || '') +
        (headers['Message-ID']?.[0] || '');
      const ids = (raw.match(/<[^>]+>/g) || []).map((s) =>
        s.slice(1, -1)
      );
      const count = ids.length;

      // Recherche rapide du premier dossier valide
      let folder = 'not found';
      for (const id of ids) {
        const msgs = (
          await browser.messages.query({ headerMessageId: id })
        ).messages;
        const ok = msgs.find(
          (m) => !/(inbox|spam|drafts?|sent)/i.test(m.folder.path)
        );
        if (ok) {
          folder = ok.folder.path;
          break;
        }
      }

      // Mise à jour du titre et activation conditionnelle
      await browser.messageDisplayAction.setTitle({
        title: `Fil (${count}) : ${folder}`,
      });
      if (folder === 'not found') {
        await browser.messageDisplayAction.disable(tab.id);
      } else {
        await browser.messageDisplayAction.enable(tab.id);
      }
    } catch {
      // En cas d’erreur, on désactive le bouton
      await browser.messageDisplayAction.disable(tab.id);
    }
  }
);

// 2. Au clic, on déplace directement le message si le bouton était actif
browser.messageDisplayAction.onClicked.addListener(async (tab) => {
  try {
    const hdr = await browser.messageDisplay.getDisplayedMessage(
      tab.id
    );
    const { headers } = await browser.messages.getFull(hdr.id);

    // Même extraction d’IDs que ci‑dessus
    const raw =
      (headers.references?.[0] || '') +
      (headers['In-Reply-To']?.[0] || '') +
      (headers['Message-ID']?.[0] || '');
    const ids = (raw.match(/<[^>]+>/g) || []).map((s) =>
      s.slice(1, -1)
    );

    // Recherche du dossier final
    let folderPath = null;
    let targetMsg = null;
    for (const id of ids) {
      const msgs = (
        await browser.messages.query({ headerMessageId: id })
      ).messages;
      const ok = msgs.find(
        (m) => !/(inbox|spam|drafts?|sent)/i.test(m.folder.path)
      );
      if (ok) {
        folderPath = ok.folder.path;
        targetMsg = ok;
        break;
      }
    }
    if (!targetMsg) throw new Error('Aucun dossier valide');

    // Déplace le message courant
    await browser.messages.move([hdr.id], targetMsg.folder);

    // Notification de succès
    await browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon-48.png'),
      title: 'Message déplacé',
      message: `Déplacé dans : ${folderPath}`,
    });
  } catch (err) {
    await browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon-48.png'),
      title: 'Erreur',
      message: err.message,
    });
  }
});
