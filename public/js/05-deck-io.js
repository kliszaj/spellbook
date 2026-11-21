    // ── Export visible saved cards as a Cardmarket import list ──
    // Cardmarket matches double-faced/split cards by their front-face name, so we
    // take the part before " // ". Non-basics are singletons; basics use their count.
    function cardmarketLine(card, qty) {
      const name = String(card.name || "").split(" // ")[0].trim();
      return `${Math.max(1, qty || 1)} ${name}`;
    }
    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand("copy"); } catch { ok = false; }
        document.body.removeChild(ta);
        return ok;
      }
    }
    let exportFlashTimer = null;
    // "missing": only what you'd have to buy — the deck's count minus the copies you own,
    // skipping basic lands (nobody orders those). Needs an uploaded collection.
    function exportLines(mode) {
      const cards = state.savedVisible || [];
      return cards.flatMap((c) => {
        const want = cardQty(state.activeFolder, c.id);
        if (mode !== "missing") return [{ c, qty: want }];
        if (isBasicLand(c)) return [];
        const need = want - ownedQty(collectionIndex, c);
        return need > 0 ? [{ c, qty: need }] : [];
      });
    }
    async function exportSavedList(mode = "all") {
      const lines = exportLines(mode);
      const label = savedExportBtn.querySelector(".export-label");
      if (!lines.length) {
        clearTimeout(exportFlashTimer);
        label.textContent = mode === "missing" ? "You own them all" : "Nothing to copy";
        exportFlashTimer = setTimeout(() => { label.textContent = "Export"; }, 1600);
        return;
      }
      const text = lines.map(({ c, qty }) => cardmarketLine(c, qty)).join("\n");
      // Quantity-weighted so the flash matches what actually pastes (basics carry ×N).
      const totalCards = lines.reduce((n, l) => n + l.qty, 0);
      const ok = await copyText(text);
      clearTimeout(exportFlashTimer);
      if (ok) {
        savedExportBtn.classList.add("copied");
        label.textContent = `Copied ${totalCards}`;
      } else {
        label.textContent = "Copy failed";
      }
      exportFlashTimer = setTimeout(() => {
        savedExportBtn.classList.remove("copied");
        label.textContent = "Export";
      }, 1600);
    }
    const exportMenu = $("#saved-export-menu");
    function closeExportMenu() { exportMenu.hidden = true; savedExportBtn.setAttribute("aria-expanded", "false"); }
    savedExportBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!exportMenu.hidden) { closeExportMenu(); return; }
      const count = (mode) => exportLines(mode).reduce((n, l) => n + l.qty, 0);
      $("#export-all-sub").textContent = `${count("all")} cards · Cardmarket list`;
      const missingBtn = exportMenu.querySelector('[data-export="missing"]');
      if (hasCollection()) {
        const n = count("missing");
        const eur = exportLines("missing").reduce((s, l) => s + (priceNum(l.c) || 0) * l.qty, 0);
        $("#export-missing-sub").textContent = n ? `${n} cards · ≈ €${eur.toFixed(2)}` : "You own every card shown";
        missingBtn.disabled = n === 0;
      } else {
        $("#export-missing-sub").textContent = "Upload your collection first";
        missingBtn.disabled = true;
      }
      exportMenu.hidden = false;
      savedExportBtn.setAttribute("aria-expanded", "true");
      exportMenu.querySelector("button:not(:disabled)")?.focus();
    });
    exportMenu.addEventListener("click", (e) => {
      const item = e.target.closest("[data-export]");
      if (!item || item.disabled) return;
      closeExportMenu();
      exportSavedList(item.dataset.export);
    });
    document.addEventListener("click", (e) => { if (!exportMenu.hidden && !e.target.closest(".export-wrap")) closeExportMenu(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !exportMenu.hidden) { closeExportMenu(); savedExportBtn.focus(); } });

    // ── Play in Playmat ──
    // Playmat (a web client for XMage) opens /import#deck=<payload> with the deck in its import sheet; the
    // player confirms there. The payload is base64url JSON {site, url, text, name}, the shape Playmat's own
    // "Send to Playmat" bookmarklet uses (Mage.Web.Client/src/core/deckImport/payload.ts). It rides in the
    // URL fragment, which the browser never sends to any server.
    // @testable playmat-helpers begin
    const PLAYMAT_MAX_PAYLOAD_BYTES = 200 * 1024; // Playmat refuses larger payloads
    function playmatDeckList(deck) {
      const line = (c) => `${Math.max(1, Math.floor(c.qty) || 1)} ${String(c.name || "").trim()}`;
      const commanders = (deck.commanders || []).filter((c) => c && c.name);
      const main = (deck.main || []).filter((c) => c && c.name);
      const parts = [];
      if (commanders.length) parts.push("Commander", ...commanders.map(line), "");
      parts.push("Deck", ...main.map(line));
      return parts.join("\n");
    }
    function encodePlaymatPayload(payload) {
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    function playmatImportUrl(base, payload) {
      const encoded = encodePlaymatPayload(payload);
      if (encoded.length > Math.ceil((PLAYMAT_MAX_PAYLOAD_BYTES * 4) / 3)) return null;
      return `${String(base).replace(/\/+$/, "")}/import#deck=${encoded}`;
    }
    // @testable playmat-helpers end

    function playmatDeckFor(deck) {
      const cards = getFolderCards(deck.id).filter((c) => !isMaybe(deck.id, c.id));
      const entry = (c) => ({ name: c.name, qty: cardQty(deck.id, c.id) });
      return {
        commanders: cards.filter((c) => c.id === deck.commanderId).map(entry),
        main: cards.filter((c) => c.id !== deck.commanderId).map(entry),
      };
    }
    $("#saved-playmat-btn").addEventListener("click", () => {
      const deck = state.folders.find((f) => f.id === state.activeFolder && f.id !== DEFAULT_FOLDER);
      if (!deck) return;
      const base = state.aiSettings?.playmatUrl || "";
      if (!base) {
        showSettings();
        const input = $("#playmat-url-input");
        input.focus();
        showStatus("Add your Playmat address in Settings first", true);
        return;
      }
      const url = playmatImportUrl(base, {
        site: "spellbook",
        url: location.origin + "/",
        text: playmatDeckList(playmatDeckFor(deck)),
        name: deck.name,
      });
      if (!url) { showStatus("This deck is too big to send to Playmat", true); return; }
      window.open(url, "_blank", "noopener");
    });

    // ── Import a pasted card list into the current deck ──
    const importModal = $("#import-modal");
    const importInput = $("#import-input");
    const importStatus = $("#import-status");
    const importRunBtn = $("#import-run");
    function showImport() { importInput.value = ""; importStatus.textContent = ""; importModal.classList.add("visible"); setTimeout(() => importInput.focus(), 0); }
    function hideImport() { importModal.classList.remove("visible"); }
    $("#saved-import-btn").addEventListener("click", showImport);
    $("#deck-start-import").addEventListener("click", showImport);
    $("#deck-start-pick").addEventListener("click", () => {
      const deck = state.folders.find((f) => f.id === state.activeFolder) || null;
      openNewDeck({ deck });
    });
    $("#import-cancel").addEventListener("click", hideImport);
    importModal.addEventListener("click", (e) => { if (e.target === importModal) hideImport(); });

    // Accepts "1 Sol Ring", "1x Sol Ring", "Sol Ring (CMR) 314", bare names, etc.
    // Returns [{ name, qty }] deduped by name (leading counts summed).
    function parseImportList(text) {
      const byName = new Map();
      (text || "").split(/\r?\n/).forEach((raw) => {
        let line = raw.trim();
        if (!line || line.startsWith("//") || line.startsWith("#")) return;
        const m = line.match(/^(\d+)\s*[xX]?\s+/);
        const qty = m ? Math.max(1, parseInt(m[1], 10) || 1) : 1;
        line = line.replace(/^\d+\s*[xX]?\s+/, "");          // leading quantity
        line = line.replace(/\s*\([^)]*\)\s*\d*\s*$/, "");    // trailing "(SET) 123"
        line = line.replace(/\s+\d+\s*$/, "");                // trailing collector number
        line = line.split("//")[0].trim();                    // front face of a DFC
        if (!line) return;
        const key = line.toLowerCase();
        const prev = byName.get(key);
        if (prev) prev.qty += qty;
        else byName.set(key, { name: line, qty });
      });
      return [...byName.values()];
    }

    importRunBtn.addEventListener("click", runImport);
    async function runImport() {
      const parsed = parseImportList(importInput.value);
      if (!parsed.length) { importStatus.textContent = "No card names found."; return; }
      const names = parsed.map((p) => p.name);
      const qtyByName = new Map(parsed.map((p) => [p.name.toLowerCase(), p.qty]));
      const target = ensureActiveDeck();
      if (!target) { importStatus.textContent = "Create a deck first (+ New deck in the deck list)."; return; }
      importRunBtn.disabled = true; importRunBtn.textContent = "Importing…";
      importStatus.textContent = `Looking up ${names.length} cards…`;
      try {
        const found = [];
        for (let i = 0; i < names.length; i += 75) {
          const res = await fetch("https://api.scryfall.com/cards/collection", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ identifiers: names.slice(i, i + 75).map((n) => ({ name: n })) }),
          });
          if (res.ok) { const d = await res.json(); found.push(...(d.data || [])); }
        }
        let added = 0;
        found.forEach((card) => {
          if (!isCardSaved(card.id) || !cardFolders(card.id).includes(target)) { setCardFolder(card, target, true); added++; }
          // Only basic lands carry a stacked count; everything else stays a singleton.
          if (isBasicLand(card)) {
            const q = qtyByName.get(String(card.name).toLowerCase());
            if (q && q > 1) setCardQty(target, card.id, q);
          }
        });
        renderFolderRail();
        renderSavedCards();
        const missing = names.length - found.length;
        importStatus.textContent = `Added ${added} card${added === 1 ? "" : "s"}${missing > 0 ? `, ${missing} not found` : ""}.`;
        if (added) setTimeout(hideImport, 1400);
      } catch (err) {
        importStatus.textContent = "Import failed — please try again.";
      } finally {
        importRunBtn.disabled = false; importRunBtn.textContent = "Import";
      }
    }

    loadMoreBtn.addEventListener("click", () => { if (state.nextPage) searchScryfall(null, state.nextPage); });

    $("#copy-query-btn").addEventListener("click", async () => {
      const btn = $("#copy-query-btn");
      const ok = await copyText(state.currentQuery);
      btn.classList.toggle("copied", ok);
      btn.title = ok ? "Copied" : "Copy failed";
      setTimeout(() => { btn.classList.remove("copied"); btn.title = "Copy the full query"; }, 1500);
    });

    $("#open-scryfall-btn").addEventListener("click", () => {
      window.open(`https://scryfall.com/search?q=${encodeURIComponent(state.currentQuery)}`, "_blank");
    });

    // Inline icons for the card hover overlay
    const ICON_DOTS = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>`;
    const ICON_PIN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>`;
    const ICON_CROWN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/><path d="M5 21h14"/></svg>`;
    function bookmarkIcon(filled) {
      return `<svg viewBox="0 0 24 24" fill="${filled ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;
    }
    // Sparkles icon (Lucide, ISC-licensed) — marks anything the AI produced
    const ICON_SPARKLE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>`;
    // Corner badge shown on cards the AI recommended (those carrying a reason)
    function aiMark(card) {
      return card._reason ? `<span class="ai-mark" title="AI recommendation">${ICON_SPARKLE}</span>` : "";
    }

