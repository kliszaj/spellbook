    // ── Authoritative sync engine ─────────────────────────────────────
    // The server owns state.json. We send precise ops (never full snapshots) so
    // deletes win and two devices can't clobber each other, and we re-pull the
    // authoritative copy on focus / visibility / online + light polling.
    const SYNC_POLL_MS = 15000;
    let pendingOps = [];
    let flushTimer = null;
    let flushing = false;
    let pollTimer = null;
    let lastSyncedSig = "";

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

    function queueOp(op) {
      if (!syncReady || !op) return;
      pendingOps.push(op);
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flushOps, 250);
    }

    async function flushOps() {
      if (flushing || !pendingOps.length) return;
      flushing = true;
      const batch = pendingOps;
      pendingOps = [];
      try {
        const res = await fetch("/api/app-state/ops", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ops: batch }),
        });
        if (!res.ok) throw new Error("sync failed");
        const serverState = await res.json();
        // Adopt the authoritative result only if nothing newer is waiting locally.
        if (!pendingOps.length) adoptServerState(serverState);
      } catch (err) {
        console.warn("op sync failed, will retry", err);
        pendingOps = batch.concat(pendingOps); // requeue for the next attempt
        flushing = false;
        clearTimeout(flushTimer);
        flushTimer = setTimeout(flushOps, 3000);
        return;
      }
      flushing = false;
      if (pendingOps.length) { clearTimeout(flushTimer); flushTimer = setTimeout(flushOps, 250); }
    }

    async function refreshFromServer() {
      // Never overwrite un-synced local edits — wait until the queue is drained.
      if (!syncReady || flushing || pendingOps.length) return;
      try {
        const res = await fetch("/api/app-state");
        if (!res.ok) return;
        const serverState = await res.json();
        if (!flushing && !pendingOps.length) adoptServerState(serverState);
      } catch (err) { /* offline — try again next tick */ }
    }

    function startStateSync() {
      if (pollTimer) return;
      pollTimer = setInterval(refreshFromServer, SYNC_POLL_MS);
      document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshFromServer(); });
      window.addEventListener("focus", refreshFromServer);
      window.addEventListener("online", refreshFromServer);
    }

