    // ── Authoritative sync engine ─────────────────────────────────────
    // The server owns state.json. We send precise ops (never full snapshots) so
    // deletes win and two devices can't clobber each other, and we re-pull the
    // authoritative copy on focus / visibility / online + light polling.
    const SYNC_POLL_MS = 15000;
    const PENDING_OPS_KEY = "pending_ops"; // unsent changes, kept so a reload or closed tab doesn't lose them
    const SYNC_MIGRATED_KEY = "sync_migrated_v1"; // set once this device's pre-sync data has been uploaded
    let pendingOps = loadPendingOps();
    let flushTimer = null;
    let flushing = false;
    let pollTimer = null;
    let lastSyncedSig = "";
    let opSeq = 0; // bumps on every local change; a server read that started before one is stale
    let syncFailures = 0;

    function loadPendingOps() {
      try {
        const ops = JSON.parse(localStorage.getItem(PENDING_OPS_KEY) || "[]");
        return Array.isArray(ops) ? ops : [];
      } catch { return []; }
    }
    function savePendingOps() {
      try {
        if (pendingOps.length) localStorage.setItem(PENDING_OPS_KEY, JSON.stringify(pendingOps));
        else localStorage.removeItem(PENDING_OPS_KEY);
      } catch { /* storage full or blocked: the in-memory queue still syncs */ }
    }

    // Adopt the server's authoritative copy, but skip the re-render when it hasn't
    // actually changed (avoids the saved grid flickering on every poll).
    function adoptServerState(serverState) {
      if (!serverState || typeof serverState !== "object") return;
      const sig = JSON.stringify([
        serverState.savedCards, serverState.folders, serverState.membership, serverState.quantities, serverState.maybeboard, serverState.pins, serverState.deckNotes,
        serverState.colorIdentity, serverState.forceAiSearch,
        serverState.searchHistory, serverState.translateCache,
      ]);
      if (sig === lastSyncedSig) return;
      lastSyncedSig = sig;
      applyAppState(serverState);
    }

    // Changes are queued even before the first load finishes (they used to be dropped then) and sent once
    // sync is ready.
    function queueOp(op) {
      if (!op) return;
      pendingOps.push(op);
      opSeq += 1;
      savePendingOps();
      if (syncReady) scheduleFlush(250);
    }
    function scheduleFlush(ms) {
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flushOps, ms);
    }

    async function flushOps() {
      if (flushing || !syncReady || !pendingOps.length) return;
      flushing = true;
      const sent = pendingOps.length;
      try {
        const res = await fetch("/api/app-state/ops", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ops: pendingOps.slice(0, sent) }),
        });
        if (!res.ok) throw new Error(`sync failed (${res.status})`);
        const serverState = await res.json();
        // drop only what was sent: changes made while it was in flight stay queued
        pendingOps = pendingOps.slice(sent);
        savePendingOps();
        syncFailures = 0;
        setSyncBadge(false);
        // Adopt the authoritative result only if nothing newer is waiting locally.
        if (!pendingOps.length) adoptServerState(serverState);
      } catch (err) {
        console.warn("op sync failed, will retry", err);
        syncFailures += 1;
        if (syncFailures >= 2) setSyncBadge(true);
        flushing = false;
        scheduleFlush(Math.min(30000, 3000 * syncFailures)); // back off while the server is down
        return;
      }
      flushing = false;
      if (pendingOps.length) scheduleFlush(250);
    }

    // Leaving the page (closing the tab, switching apps on a phone): send what's queued now, with keepalive so
    // the browser finishes the request after the page is gone. The queue stays saved until the server confirms,
    // so anything this misses is sent on the next visit (every op is safe to apply twice).
    function flushOnLeave() {
      if (!syncReady || flushing || !pendingOps.length) return;
      clearTimeout(flushTimer);
      const sent = pendingOps.length;
      const body = JSON.stringify({ ops: pendingOps });
      if (body.length > 60000) return; // over the keepalive limit: the next visit sends it
      flushing = true;
      fetch("/api/app-state/ops", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true })
        .then((res) => {
          if (!res.ok) return;
          pendingOps = pendingOps.slice(sent);
          savePendingOps();
        })
        .catch(() => {})
        .finally(() => { flushing = false; if (pendingOps.length) scheduleFlush(250); });
    }

    function setSyncBadge(on) {
      let el = document.getElementById("sync-badge");
      if (!on && !el) return;
      if (!el) {
        el = document.createElement("div");
        el.id = "sync-badge";
        el.className = "sync-badge";
        el.setAttribute("role", "status");
        document.body.append(el);
      }
      el.hidden = !on;
      el.textContent = on ? "Not synced · your changes are kept on this device and will sync when the server answers" : "";
    }

    async function refreshFromServer() {
      // Never overwrite un-synced local edits — wait until the queue is drained.
      if (!syncReady || flushing || pendingOps.length) return;
      const seq = opSeq;
      try {
        const res = await fetch("/api/app-state");
        if (!res.ok) return;
        const serverState = await res.json();
        // A change made (and maybe already sent) while this read was in flight makes it stale.
        if (seq === opSeq && !flushing && !pendingOps.length) adoptServerState(serverState);
      } catch (err) { /* offline — try again next tick */ }
    }

    function startStateSync() {
      if (pollTimer) return;
      pollTimer = setInterval(refreshFromServer, SYNC_POLL_MS);
      document.addEventListener("visibilitychange", () => { if (document.hidden) flushOnLeave(); else refreshFromServer(); });
      window.addEventListener("pagehide", flushOnLeave);
      window.addEventListener("focus", refreshFromServer);
      window.addEventListener("online", () => { refreshFromServer(); flushOps(); });
    }
