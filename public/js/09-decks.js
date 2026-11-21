    // ── Saves & folders ──────────────────────────────────────────────
    // These mirror state into localStorage as a local cache. Syncing to the server
    // happens via precise queueOp() calls at each mutation site (see below).
    function saveCardsStore() {
      lsSet("saved_cards", JSON.stringify(state.savedCards));
    }
    function saveFolders() {
      lsSet("card_folders", JSON.stringify(state.folders));
    }
    function saveMembership() {
      lsSet("card_membership", JSON.stringify(state.membership));
    }

    // Build membership for pre-folders saves: everything goes into the default collection.
    function migrateMembership() {
      if (!state.membership || typeof state.membership !== "object") {
        state.membership = {};
        // Pre-folders saves go into a real deck (Unsorted no longer exists, and
        // retireUnsorted would remove cards left only there).
        if (state.savedCards.length) {
          const f = createFolder("Imported cards");
          if (f) state.savedCards.forEach((c) => { state.membership[c.id] = [f.id]; });
        }
        saveMembership();
      }
    }

    // "All" and "Unsorted" are gone (the Collection tab covers "everything I have"); the
    // Decks tab always shows a real deck, or an empty state when there are none.
    function ensureActiveDeck() {
      const live = state.folders.filter((f) => f.id !== pendingDeckDelete?.id);
      if (!live.some((f) => f.id === state.activeFolder)) state.activeFolder = live[0]?.id || null;
      return state.activeFolder;
    }
    // One-time cleanup after server data loads: drop the old Unsorted membership. Cards that
    // were only in Unsorted are removed from saved cards (the user chose this; the server's
    // daily state backups can restore them). Cards also in a real deck just lose the tag.
    function retireUnsorted() {
      const loose = state.savedCards.filter((c) => cardFolders(c.id).includes(DEFAULT_FOLDER));
      loose.forEach((c) => setCardFolder(c, DEFAULT_FOLDER, false));
      return loose.length;
    }
    function isCardSaved(id) { return state.savedCards.some((s) => s.id === id); }
    function cardFolders(id) { return state.membership[id] || []; }
    function getFolderCards(folderId) {
      if (folderId === "all") return state.savedCards.slice();
      return state.savedCards.filter((c) => cardFolders(c.id).includes(folderId));
    }
    function folderCount(folderId) {
      if (folderId === "all") return state.savedCards.length;
      return state.savedCards.reduce((n, c) => n + (cardFolders(c.id).includes(folderId) && !isMaybe(folderId, c.id) ? cardQty(folderId, c.id) : 0), 0);
    }
    function folderMaybeCount(folderId) {
      if (folderId === "all" || folderId === DEFAULT_FOLDER) return 0;
      return state.savedCards.reduce((n, c) => n + (cardFolders(c.id).includes(folderId) && isMaybe(folderId, c.id) ? cardQty(folderId, c.id) : 0), 0);
    }

    // ── Basic-land quantities (per deck) ──────────────────────────────
    // Only basic lands carry a count > 1; every other card is a singleton, so
    // cardQty returns 1 for them and the qty-weighted math stays a no-op.
    const isBasicLand = (c) => c && (c.type_line || "").includes("Basic") && isLandCard(c);
    function cardQty(folderId, id) {
      if (!folderId || folderId === "all") return 1;
      const counts = state.quantities[folderId];
      const n = counts && counts[id];
      return Number.isFinite(n) && n > 0 ? n : 1;
    }
    function setCardQty(folderId, id, n) {
      if (!folderId || folderId === "all") return;
      n = Math.max(1, Math.floor(Number(n) || 1));
      if (!state.quantities[folderId]) state.quantities[folderId] = {};
      if (n <= 1) delete state.quantities[folderId][id];
      else state.quantities[folderId][id] = n;
      if (!Object.keys(state.quantities[folderId]).length) delete state.quantities[folderId];
      persistQuantities();
    }
    function persistQuantities() {
      lsSet("card_quantities", JSON.stringify(state.quantities));
      queueOp({ type: "setQuantities", quantities: state.quantities });
    }

    // ── Maybeboard (per deck) ──────────────────────────────────────────
    // A card stays a member of the deck but is set aside in its own section and
    // excluded from deck size, analysis, and export. Only meaningful within a real
    // deck — "all" and Unsorted never carry Maybe state.
    function isMaybe(folderId, id) {
      if (!folderId || folderId === "all" || folderId === DEFAULT_FOLDER) return false;
      return Boolean(state.maybeboard[folderId] && state.maybeboard[folderId][id]);
    }
    function setMaybe(folderId, id, on) {
      if (!folderId || folderId === "all" || folderId === DEFAULT_FOLDER) return;
      if (on) {
        if (!state.maybeboard[folderId]) state.maybeboard[folderId] = {};
        state.maybeboard[folderId][id] = true;
      } else if (state.maybeboard[folderId]) {
        delete state.maybeboard[folderId][id];
        if (!Object.keys(state.maybeboard[folderId]).length) delete state.maybeboard[folderId];
      }
      persistMaybeboard();
    }
    // ── Pins (per deck): "keep this card" — never offered as a cut in the trim planner.
    function isPinned(folderId, id) {
      return Boolean(state.pins[folderId] && state.pins[folderId][id]);
    }
    function setPinned(folderId, id, on) {
      if (!folderId || folderId === "all" || folderId === DEFAULT_FOLDER) return;
      if (on) {
        if (!state.pins[folderId]) state.pins[folderId] = {};
        state.pins[folderId][id] = true;
      } else if (state.pins[folderId]) {
        delete state.pins[folderId][id];
        if (!Object.keys(state.pins[folderId]).length) delete state.pins[folderId];
      }
      persistPins();
    }
    function persistPins() {
      lsSet("card_pins", JSON.stringify(state.pins));
      queueOp({ type: "setPins", pins: state.pins });
    }
    function persistMaybeboard() {
      lsSet("card_maybeboard", JSON.stringify(state.maybeboard));
      queueOp({ type: "setMaybeboard", maybeboard: state.maybeboard });
    }

    // Add/remove a card to/from one collection. Auto-saves the card on first add;
    // fully unsaves it (and drops membership) when it ends up in no collection.
    function setCardFolder(card, folderId, on) {
      let mem = state.membership[card.id] ? state.membership[card.id].slice() : [];
      if (on) {
        if (!isCardSaved(card.id)) state.savedCards.push(card);
        if (!mem.includes(folderId)) mem.push(folderId);
        state.membership[card.id] = mem;
      } else {
        mem = mem.filter((f) => f !== folderId);
        if (mem.length === 0) {
          delete state.membership[card.id];
          const idx = state.savedCards.findIndex((s) => s.id === card.id);
          if (idx >= 0) state.savedCards.splice(idx, 1);
        } else {
          state.membership[card.id] = mem;
        }
        setCardQty(folderId, card.id, 1); // drop any stored count for the folder it left
        setMaybe(folderId, card.id, false); // drop any Maybe flag for the folder it left
      }
      saveCardsStore();
      saveMembership();
      // Empty membership => the card was fully unsaved; server drops it everywhere.
      queueOp({ type: "moveCard", id: card.id, card, folders: state.membership[card.id] || [] });
    }

    function newFolderId() {
      return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : "f" + Date.now() + Math.floor(Math.random() * 1e6);
    }
    function createFolder(name) {
      const n = (name || "").trim();
      if (!n) return null;
      const folder = { id: newFolderId(), name: n, commanderId: null };
      state.folders.push(folder);
      saveFolders();
      queueOp({ type: "setFolders", folders: state.folders });
      return folder;
    }
    // Designate (or clear) a deck's commander. Persists via the setFolders op.
    function setDeckCommander(deckId, cardId) {
      const deck = state.folders.find((f) => f.id === deckId);
      if (!deck) return;
      deck.commanderId = deck.commanderId === cardId ? null : cardId;
      if (deck.commanderId) setMaybe(deckId, cardId, false); // the commander can never be Maybe
      saveFolders();
      queueOp({ type: "setFolders", folders: state.folders });
      renderSavedCards();
    }
    function renameFolder(id, name) {
      const f = state.folders.find((x) => x.id === id);
      const n = (name || "").trim();
      if (f && n) { f.name = n; saveFolders(); queueOp({ type: "setFolders", folders: state.folders }); }
    }
    function deleteFolder(id) {
      // Leaving the deck removes a card that's in no other deck (setCardFolder does that).
      getFolderCards(id).forEach((c) => setCardFolder(c, id, false));
      state.folders = state.folders.filter((f) => f.id !== id);
      if (state.quantities[id]) { delete state.quantities[id]; persistQuantities(); }
      if (state.maybeboard[id]) { delete state.maybeboard[id]; persistMaybeboard(); }
      if (state.pins[id]) { delete state.pins[id]; persistPins(); }
      if (state.deckNotes[id]) { delete state.deckNotes[id]; persistDeckNotes(); }
      if (deckReviewCache[id]) { delete deckReviewCache[id]; persistDeckReviews(); }
      saveFolders();
      saveMembership();
      queueOp({ type: "setFolders", folders: state.folders });
      queueOp({ type: "replaceMembership", membership: state.membership });
      if (state.activeFolder === id) state.activeFolder = null;
      ensureActiveDeck();
    }

    // ── Folder sidebar ──
    // A deleted deck is hidden at once and only really deleted when its Undo toast expires
    // (or another deck is deleted, or the page is hidden), so Undo needs no restore logic.
    var pendingDeckDelete = null; // { id, timer } — var: ensureActiveDeck can run before this line
    function commitPendingDeckDelete() {
      if (!pendingDeckDelete) return;
      const { id, timer } = pendingDeckDelete;
      clearTimeout(timer);
      pendingDeckDelete = null;
      deleteFolder(id);
      if (state.activeTab === "saved") renderSavedCards(); else renderFolderRail();
    }
    function requestDeckDelete(fid) {
      commitPendingDeckDelete();
      const f = state.folders.find((x) => x.id === fid);
      if (!f) return;
      const only = getFolderCards(fid).filter((c) => cardFolders(c.id).length === 1).length;
      pendingDeckDelete = { id: fid, timer: setTimeout(commitPendingDeckDelete, 7000) };
      if (state.activeFolder === fid) state.activeFolder = state.folders.find((x) => x.id !== fid)?.id || null;
      renderSavedCards();
      showToast(`Deleted "${f.name}"${only ? ` and ${only} card${only === 1 ? "" : "s"} only in it` : ""}`, {
        actionLabel: "Undo",
        onAction: () => {
          if (pendingDeckDelete?.id !== fid) return;
          clearTimeout(pendingDeckDelete.timer);
          pendingDeckDelete = null;
          state.activeFolder = fid;
          renderSavedCards();
        },
      });
    }
    document.addEventListener("visibilitychange", () => { if (document.hidden) commitPendingDeckDelete(); });
    window.addEventListener("pagehide", commitPendingDeckDelete);
    // Rename in place: the row becomes a text field. Enter or leaving the field saves, Esc cancels.
    function startDeckRename(fid) {
      const btn = folderRail.querySelector(`.folder-btn[data-folder="${fid}"]`);
      const f = state.folders.find((x) => x.id === fid);
      if (!btn || !f) return;
      const row = document.createElement("div");
      row.className = "folder-btn renaming" + (btn.classList.contains("active") ? " active" : "");
      row.innerHTML = `<input class="folder-rename" type="text" aria-label="Deck name" maxlength="80"><span class="folder-count">${folderCount(fid)}</span>`;
      const input = row.querySelector("input");
      input.value = f.name;
      btn.replaceWith(row);
      input.focus();
      input.select();
      let done = false;
      const finish = (save) => {
        if (done) return;
        done = true;
        if (save && input.value.trim() && input.value.trim() !== f.name) renameFolder(fid, input.value);
        if (state.activeTab === "saved") renderSavedCards(); else renderFolderRail();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
      });
      input.addEventListener("blur", () => finish(true));
    }

    function renderFolderRail() {
      ensureActiveDeck();
      const items = state.folders.filter((f) => f.id !== pendingDeckDelete?.id);
      let html = `<div class="rail-label">Decks</div>${items.length ? "" : `<div class="rail-empty">No decks yet</div>`}`;
      items.forEach((f) => {
        const custom = true;
        const maybeCount = folderMaybeCount(f.id);
        const countLabel = `${folderCount(f.id)}${maybeCount ? ` <span class="folder-count-maybe">(${maybeCount})</span>` : ""}`;
        html += `<button class="folder-btn ${state.activeFolder === f.id ? "active" : ""}" data-folder="${f.id}">
            <span class="folder-name">${esc(f.name)}</span>
            <span class="folder-count">${countLabel}</span>
            <span class="folder-edit-group">${custom ? `<span class="folder-edit" data-act="rename" data-folder="${f.id}" title="Rename" role="button" aria-label="Rename ${escAttr(f.name)}">&#9998;</span><span class="folder-edit" data-act="delete" data-folder="${f.id}" title="Delete" role="button" aria-label="Delete ${escAttr(f.name)}">&#10005;</span>` : ""}</span>
          </button>`;
      });
      html += `<div class="rail-divider"></div><button class="folder-add" id="folder-add-btn" type="button"><span class="add-ico">${ICON_ADD_PLUS}</span>New deck</button>`;
      folderRail.innerHTML = html;
    }

    folderRail.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]");
      if (act) {
        e.stopPropagation();
        const fid = act.dataset.folder;
        if (act.dataset.act === "rename") startDeckRename(fid);
        else requestDeckDelete(fid);
        return;
      }
      if (e.target.closest("#folder-add-btn")) { openNewDeck(); return; }
      if (e.target.closest(".renaming")) return;
      const btn = e.target.closest(".folder-btn");
      if (btn) { state.activeFolder = btn.dataset.folder; renderSavedCards(); }
    });

    // ── Save-to-folder popover ──
    let popoverAnchor = null;

    function openSavePopover(card, anchorEl) {
      state.popoverCard = card;
      popoverAnchor = anchorEl;
      popAddForm.classList.remove("visible");
      popAddBtn.style.display = "";
      renderPopoverList();
      savePopover.classList.add("visible");
      positionPopover(anchorEl);
      syncSaveUI();
    }

    function renderPopoverList() {
      const card = state.popoverCard;
      if (!card) return;
      const mem = cardFolders(card.id);
      const collections = state.folders;
      popList.innerHTML = collections.map((f) => `
        <label class="pop-row">
          <input type="checkbox" data-folder="${f.id}" ${mem.includes(f.id) ? "checked" : ""}>
          <span class="pop-name">${esc(f.name)}</span>
        </label>`).join("") || `<div class="pop-empty">No decks yet. Create one below.</div>`;
    }

    function positionPopover(anchorEl) {
      if (!anchorEl) return;
      const r = anchorEl.getBoundingClientRect();
      const pw = savePopover.offsetWidth || 230;
      const ph = savePopover.offsetHeight || 200;
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      let left = Math.min(r.right - pw, vw - pw - 8);
      left = Math.max(8, left);
      let top = r.bottom + 6;
      if (top + ph + 8 > vh) top = Math.max(8, r.top - ph - 6);
      savePopover.style.left = left + "px";
      savePopover.style.top = top + "px";
    }

    function closeSavePopover() {
      if (!savePopover.classList.contains("visible")) return;
      savePopover.classList.remove("visible");
      popAddForm.classList.remove("visible");
      popAddBtn.style.display = "";
      state.popoverCard = null;
      popoverAnchor = null;
      if (state.activeTab === "saved") renderSavedCards();
    }

    popList.addEventListener("change", (e) => {
      const cb = e.target.closest("input[type=checkbox]");
      if (!cb || !state.popoverCard) return;
      setCardFolder(state.popoverCard, cb.dataset.folder, cb.checked);
      syncSaveUI();
      if (!isCardSaved(state.popoverCard.id)) closeSavePopover();
    });

    popAddBtn.addEventListener("click", () => {
      popAddBtn.style.display = "none";
      popAddForm.classList.add("visible");
      popAddInput.value = "";
      popAddInput.focus();
    });

    popAddForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const f = createFolder(popAddInput.value);
      if (f && state.popoverCard) {
        setCardFolder(state.popoverCard, f.id, true);
        renderPopoverList();
        syncSaveUI();
      }
      popAddForm.classList.remove("visible");
      popAddBtn.style.display = "";
      positionPopover(popoverAnchor);
    });

    // close on outside click (the bookmark/detail buttons stopPropagation, so they won't self-close)
    document.addEventListener("click", (e) => {
      if (!savePopover.classList.contains("visible")) return;
      if (savePopover.contains(e.target)) return;
      closeSavePopover();
    });

    // ── Card right-click context menu ──
    let contextMenuCard = null;

    function activeDeck() {
      return (state.activeFolder !== "all" && state.activeFolder !== DEFAULT_FOLDER)
        ? state.folders.find((f) => f.id === state.activeFolder) || null
        : null;
    }

    function openCardContextMenu(card, x, y, { deckActions = true } = {}) {
      contextMenuCard = card;
      const deck = activeDeck();
      const isCommanderCard = Boolean(deck && deck.commanderId === card.id);
      const commanderItem = cardContextMenu.querySelector('[data-act="commander"]');
      const maybeItem = cardContextMenu.querySelector('[data-act="maybe"]');
      const removeItem = cardContextMenu.querySelector('[data-act="remove"]');
      const pinItem = cardContextMenu.querySelector('[data-act="pin"]');
      const ownedItem = cardContextMenu.querySelector('[data-act="owned"]');

      if (deckActions && deck && isLegendaryCreature(card)) {
        commanderItem.style.display = "";
        commanderItem.textContent = isCommanderCard ? "Unset commander" : "Set as commander";
      } else {
        commanderItem.style.display = "none";
      }

      if (deckActions && deck && !isCommanderCard) {
        maybeItem.style.display = "";
        maybeItem.textContent = isMaybe(deck.id, card.id) ? "Move to main deck" : "Mark as Maybe";
      } else {
        maybeItem.style.display = "none";
      }

      removeItem.style.display = (deckActions && deck) ? "" : "none";
      if (deckActions && deck && !isCommanderCard) {
        pinItem.style.display = "";
        pinItem.textContent = isPinned(deck.id, card.id) ? "Unpin" : "Pin (keep)";
      } else {
        pinItem.style.display = "none";
      }

      if (hasCollection()) {
        const info = ownedInfo(card);
        ownedItem.style.display = "";
        ownedItem.classList.toggle("disabled", info.state === "manabox");
        if (info.state === "manabox") {
          ownedItem.textContent = "Owned (from ManaBox)";
          ownedItem.setAttribute("aria-disabled", "true");
        } else {
          ownedItem.textContent = info.state === "manual" ? "Unmark owned" : "Mark as owned";
          ownedItem.removeAttribute("aria-disabled");
        }
      } else {
        ownedItem.style.display = "none";
      }

      cardContextMenu.classList.add("visible");
      positionContextMenu(x, y);
    }

    function positionContextMenu(x, y) {
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const w = cardContextMenu.offsetWidth || 190;
      const h = cardContextMenu.offsetHeight || 160;
      cardContextMenu.style.left = Math.max(8, Math.min(x, vw - w - 8)) + "px";
      cardContextMenu.style.top = Math.max(8, Math.min(y, vh - h - 8)) + "px";
    }

    function closeCardContextMenu() {
      if (!cardContextMenu.classList.contains("visible")) return;
      cardContextMenu.classList.remove("visible");
      contextMenuCard = null;
    }

    cardContextMenu.addEventListener("click", (e) => {
      const btn = e.target.closest(".ctx-item");
      if (!btn || !contextMenuCard) return;
      const card = contextMenuCard;
      const deck = activeDeck();
      switch (btn.dataset.act) {
        case "details":
          showDetail(card);
          break;
        case "commander":
          if (deck) setDeckCommander(deck.id, card.id);
          break;
        case "maybe":
          if (deck) {
            setMaybe(deck.id, card.id, !isMaybe(deck.id, card.id));
            renderSavedCards();
            if (state.detailCard && state.detailCard.id === card.id) showDetail(state.detailCard);
          }
          break;
        case "pin":
          if (deck) {
            setPinned(deck.id, card.id, !isPinned(deck.id, card.id));
            renderSavedCards();
          }
          break;
        case "remove":
          if (deck) {
            setCardFolder(card, deck.id, false);
            syncSaveUI();
            renderSavedCards();
          }
          break;
        case "owned":
          if (btn.getAttribute("aria-disabled") !== "true") toggleOwned(card);
          break;
      }
      closeCardContextMenu();
    });

    document.addEventListener("click", (e) => {
      if (!cardContextMenu.classList.contains("visible")) return;
      if (cardContextMenu.contains(e.target)) return;
      closeCardContextMenu();
    });

    // Clicking empty space deselects the focused card. Interactive elements and the
    // panels that act on the focused card are exempt so acting never deselects.
    document.addEventListener("click", (e) => {
      if (!state.detailCard) return;
      if (e.target.closest(".card-item, .detail-panel, .save-popover, .context-menu, .modal-overlay, button, input, select, textarea, label, a, summary")) return;
      state.detailCard = null;
      $("#detail-panel").classList.add("empty");
    });

    // Reflect save state everywhere after a membership change.
    function syncSaveUI() {
      refreshResultsSaveState();
      updateSavedCount();
      renderFolderRail();
      if (state.detailCard) {
        const dSaved = isCardSaved(state.detailCard.id);
        const sb = $("#detail-save-btn");
        sb.textContent = dSaved ? "Saved" : "Save";
        sb.className = dSaved ? "saved" : "";
      }
    }

    function refreshResultsSaveState() {
      document.querySelectorAll("#results .save-btn, #collection-grid .save-btn, #swaps-grid .save-btn, #da2-edhrec .save-btn").forEach((btn) => {
        const id = btn.dataset.id;
        const saved = isCardSaved(id);
        btn.innerHTML = bookmarkIcon(saved);
        btn.classList.toggle("saved", saved);
        btn.title = saved ? "Saved" : "Save";
        btn.setAttribute("aria-label", saved ? "Edit decks" : "Save");
      });
    }

    function updateSavedCount() {
      if (savedCountEl) savedCountEl.textContent = state.savedCards.length;
      if (savedCountRailEl) savedCountRailEl.textContent = state.savedCards.length;
    }

    // Helpers
    // Scryfall card images go through the server's disk cache (/img/…, see lib/image-cache.js)
    // so every device gets them from the Unraid box after the first load. Mirrors
    // toCachedUrl on the server: only Scryfall CDN paths are rewritten.
    const SCRYFALL_IMG_RE = /^https:\/\/cards\.scryfall\.io\/((small|normal|large|art_crop|border_crop)\/(front|back)\/[0-9a-f]\/[0-9a-f]\/[0-9a-f-]{36}\.(jpg|png))(\?.*)?$/;
    function cachedImg(url) {
      const m = SCRYFALL_IMG_RE.exec(String(url || ""));
      return m ? `/img/${m[1]}` : (url || "");
    }
    function getCardImage(card) {
      if (card.image_uris?.normal) return cachedImg(card.image_uris.normal);
      if (card.card_faces?.[0]?.image_uris?.normal) return cachedImg(card.card_faces[0].image_uris.normal);
      return "";
    }

    function getPrice(card) {
      if (card.prices?.eur) return `€${card.prices.eur}`;
      if (card.prices?.eur_foil) return `€${card.prices.eur_foil} (foil)`;
      return null;
    }

    function esc(str) { const d = document.createElement("div"); d.textContent = str; return d.innerHTML; }
    function capitalize(str) { return str.charAt(0).toUpperCase() + str.slice(1); }

    function showStatus(msg, isError) {
      stopLoadingAnimation();
      statusEl.textContent = msg;
      statusEl.className = `status${isError ? " error" : ""}`;
      statusEl.style.display = "block";
    }

    function hideStatus() { stopLoadingAnimation(); statusEl.style.display = "none"; }

