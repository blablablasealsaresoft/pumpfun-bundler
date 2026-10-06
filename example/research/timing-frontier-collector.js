/**
 * Append-only timing-frontier telemetry.
 * Research only. Failures stay in the caller. This file does not submit transactions.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const tf = require("./timing-frontier-v1");

let tracePath = null;
const book = tf.emptyBook();
let loaded = false;

function defaultTracePath() {
  return path.join(__dirname, "..", "..", "..", "wallets", "timing-frontier.jsonl");
}

function traceFile() {
  return tracePath || defaultTracePath();
}

function setTracePath(p) {
  tracePath = p;
  loaded = false;
  book.launches.clear();
  book.trades.clear();
  book.duplicateMerges = 0;
  book.tradeObservations = 0;
  book.executedTradeStates = 0;
  book.leakage = 0;
}

function resetForTests() {
  setTracePath(tracePath);
}

function append(row) {
  const file = traceFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + "\n");
}

function ingest(row) {
  if (!row || row.featureVersion && row.featureVersion !== tf.FEATURE_VERSION) return;
  if (row.type === "timing_create_state_v1") tf.observeCreate(book, row);
  else if (row.type === tf.EVENT_TYPE) tf.observeTrade(book, row);
  else if (row.type === "timing_cutoff_v1") tf.observeCutoff(book, row);
  else if (row.type === "timing_source_v1") tf.observeSource(book, row);
  else if (row.type === "timing_migration_v1") tf.observeMigration(book, row);
}

function load() {
  if (loaded) return book;
  loaded = true;
  const file = traceFile();
  if (!fs.existsSync(file)) return book;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\n/)) {
    if (!line.trim()) continue;
    try {
      ingest(JSON.parse(line));
    } catch {
      /* ignore a torn line */
    }
  }
  return book;
}

function noteLogs(input) {
  load();
  const beforeTrades = new Set(book.trades.keys());
  const beforeLaunches = new Map();
  for (const [mint, launch] of book.launches) {
    beforeLaunches.set(mint, {
      createSig: launch.create ? launch.create.txSignature : null,
      curve: launch.curveCompletedAt,
      migration: launch.migrationObservedAt,
    });
  }
  tf.noteLogs(book, input || {});
  for (const [mint, launch] of book.launches) {
    const prev = beforeLaunches.get(mint);
    if (
      launch.create &&
      launch.create.txSignature === (input && input.txSignature) &&
      (!prev || prev.createSig !== launch.create.txSignature)
    ) {
      append({
        type: "timing_create_state_v1",
        featureVersion: tf.FEATURE_VERSION,
        ...launch.create,
      });
    }
    if (launch.curveCompletedAt != null && (!prev || prev.curve == null)) {
      append({
        type: "timing_migration_v1",
        featureVersion: tf.FEATURE_VERSION,
        mint,
        observedAt: launch.curveCompletedAt,
        kind: "complete",
      });
    }
    if (launch.migrationObservedAt != null && (!prev || prev.migration == null)) {
      append({
        type: "timing_migration_v1",
        featureVersion: tf.FEATURE_VERSION,
        mint,
        observedAt: launch.migrationObservedAt,
        kind: "migration",
        venue: launch.venueAfterMigration,
      });
    }
  }
  for (const [key, trade] of book.trades) {
    if (!beforeTrades.has(key)) {
      append({ ...trade, type: tf.EVENT_TYPE, featureVersion: tf.FEATURE_VERSION });
    }
  }
  return book;
}

function noteCutoff(input) {
  load();
  const row = tf.observeCutoff(book, input || {});
  if (!row) return null;
  append({
    type: "timing_cutoff_v1",
    featureVersion: tf.FEATURE_VERSION,
    mint: input.mint,
    decisionCutoffAt: input.decisionCutoffAt,
    creator: input.creator || null,
    deployer: input.deployer || null,
    createSig: input.createSig || null,
    mayhem: input.mayhem === true,
    quoteMint: input.quoteMint || null,
  });
  return row;
}

function noteSourceClock(input) {
  load();
  const row = tf.observeSource(book, input || {});
  if (!row) return null;
  append({
    type: "timing_source_v1",
    featureVersion: tf.FEATURE_VERSION,
    txSignature: input.txSignature,
    mint: input.mint || null,
    source: input.source || null,
    observedAt: input.observedAt,
    slot: input.slot == null ? null : input.slot,
  });
  return row;
}

function getBook() {
  return load();
}

module.exports = {
  setTracePath,
  resetForTests,
  noteLogs,
  noteCutoff,
  noteSourceClock,
  getBook,
  traceFile,
};
