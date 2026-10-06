/**
 * RPC budget for research enrichment.
 *
 * Concepts adapted from:
 *   blablablasealsaresoft/chainstack-pumpfun-bonkfun-bot
 *     src/core/rpc_rate_limiter.py (token bucket)
 *   blablablasealsaresoft/chainstack-rpc-nodes-mcp
 *     normalized RPC errors, timeouts, method instrumentation
 *
 * Enrichment is queued off the observation path and cannot move decisionCutoffAt.
 */
"use strict";

function createTokenBucket({ capacity = 8, refillPerSec = 4, now = Date.now } = {}) {
  let tokens = capacity;
  let last = now();
  return {
    tryTake(n = 1) {
      const t = now();
      const elapsed = Math.max(0, t - last) / 1000;
      tokens = Math.min(capacity, tokens + elapsed * refillPerSec);
      last = t;
      if (tokens < n) return false;
      tokens -= n;
      return true;
    },
    level() {
      return tokens;
    },
  };
}

function classifyRpcError(err) {
  const msg = String((err && err.message) || err || "");
  if (/timeout|timed out|deadline/i.test(msg)) return "timeout";
  if (/429|rate/i.test(msg)) return "rate_limit";
  if (/403|401|api key/i.test(msg)) return "auth";
  if (/blockhash|slot/i.test(msg)) return "slot";
  return "rpc_error";
}

function createEnrichmentQueue() {
  const jobs = [];
  return {
    enqueue(job) {
      jobs.push(job);
    },
    pending() {
      return jobs.length;
    },
    drain() {
      const batch = jobs.splice(0, jobs.length);
      const notes = [];
      for (const job of batch) notes.push(job());
      return notes;
    },
  };
}

/**
 * Freeze the decision snapshot immediately. Enrichment runs later and may only
 * attach postCutoff notes.
 */
function observeThenEnrich(event, queue, enrich) {
  const snapshot = {
    mint: event.mint,
    firstObservedAt: event.observedAt,
    decisionCutoffAt: event.decisionCutoffAt != null ? event.decisionCutoffAt : event.observedAt,
    decisionFeatures: { ...(event.decisionFeatures || {}) },
    postCutoff: {},
  };
  const cutoff = snapshot.decisionCutoffAt;
  queue.enqueue(() => {
    const extra = enrich ? enrich(event) : {};
    for (const [key, value] of Object.entries(extra || {})) {
      snapshot.postCutoff[key] = value;
    }
    if (snapshot.decisionCutoffAt !== cutoff) {
      throw new Error("enrichment moved decisionCutoffAt");
    }
    return snapshot.mint;
  });
  return snapshot;
}

function instrumentCall(record, fn) {
  const t0 = Date.now();
  try {
    const value = fn();
    record({
      durationMs: Date.now() - t0,
      success: true,
      errorClass: null,
      retryCount: 0,
    });
    return value;
  } catch (err) {
    record({
      durationMs: Date.now() - t0,
      success: false,
      errorClass: classifyRpcError(err),
      retryCount: 0,
    });
    throw err;
  }
}

module.exports = {
  createTokenBucket,
  classifyRpcError,
  createEnrichmentQueue,
  observeThenEnrich,
  instrumentCall,
};
