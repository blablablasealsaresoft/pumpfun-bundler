/**
 * Append-only wallet-flow telemetry.
 * Failures are swallowed by the caller. This file does not submit transactions.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const flow = require("./wallet-flow-v1");

let tracePath = null;
const book = flow.emptyBook();
let loaded = false;

function defaultTracePath() {
  return path.join(__dirname, "..", "..", "..", "wallets", "v3-wallet-flow.jsonl");
}

function traceFile() {
  return tracePath || defaultTracePath();
}

function setTracePath(p) {
  tracePath = p;
  loaded = false;
  book.launches.clear();
  book.events.clear();
}

function append(row) {
  const file = traceFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + "\n");
}

function load() {
  if (loaded) return;
  loaded = true;
  const file = traceFile();
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\n+/)) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type === "wallet_flow_launch") {
      flow.noteCandidate(book, row);
      if (row.decisionCutoffAt != null) {
        const launch = book.launches.get(row.mint);
        if (launch && launch.decisionCutoffAt == null) launch.decisionCutoffAt = row.decisionCutoffAt;
        if (launch) {
          launch.sourceCountAtDecision = row.sourceCountAtDecision;
          launch.deployerEvidenceN = row.deployerEvidenceN;
          launch.deployerRawQuality = row.deployerRawQuality;
          launch.pnl = row.pnl;
          launch.mfe = row.mfe;
          launch.mae = row.mae;
          launch.runner10 = row.runner10;
          launch.outcomeObservedAt = row.outcomeObservedAt;
          launch.mayhem = row.mayhem === true;
          launch.firstObservedAt = row.firstObservedAt;
        }
      }
    } else if (row.type === "wallet_flow_event") {
      flow.observeFlow(book, row);
    } else if (row.type === "wallet_flow_outcome") {
      const launch = book.launches.get(row.mint);
      if (!launch) continue;
      launch.pnl = row.pnl;
      launch.mfe = row.mfe;
      launch.mae = row.mae;
      launch.runner10 = row.runner10;
      launch.outcomeObservedAt = row.outcomeObservedAt;
    }
  }
}

function noteCandidate(input) {
  load();
  if (!input || !input.mint) return null;
  const existed = book.launches.has(input.mint);
  const row = flow.noteCandidate(book, input);
  if (!row || existed) return row;
  append({ type: "wallet_flow_launch", ...row, observedAt: input.observedAt });
  return row;
}

function noteDecision(trace) {
  load();
  const before = book.launches.get(trace && trace.mint);
  const cutoffBefore = before ? before.decisionCutoffAt : null;
  const row = flow.noteDecision(book, trace);
  if (!row) return null;
  if (cutoffBefore == null && row.decisionCutoffAt != null) {
    append({
      type: "wallet_flow_launch",
      mint: row.mint,
      createSignature: row.createSignature,
      firstObservedAt: row.firstObservedAt,
      decisionCutoffAt: row.decisionCutoffAt,
      creator: row.creator,
      deployer: row.deployer,
      quoteMint: row.quoteMint,
      mayhem: row.mayhem,
      sourceCountAtDecision: row.sourceCountAtDecision,
      deployerEvidenceN: row.deployerEvidenceN,
      deployerRawQuality: row.deployerRawQuality,
      featureVersion: flow.FEATURE_VERSION,
      researchEpoch: flow.RESEARCH_EPOCH,
    });
  }
  if (typeof trace.skipReason === "string" && trace.skipReason.includes("|outcome")) {
    append({
      type: "wallet_flow_outcome",
      mint: row.mint,
      createSignature: row.createSignature,
      decisionCutoffAt: row.decisionCutoffAt,
      pnl: row.pnl,
      mfe: row.mfe,
      mae: row.mae,
      runner10: row.runner10,
      outcomeObservedAt: row.outcomeObservedAt,
      featureVersion: flow.FEATURE_VERSION,
      researchEpoch: flow.RESEARCH_EPOCH,
    });
  }
  return row;
}

function noteFlow(input) {
  load();
  const launch = book.launches.get(input && input.mint);
  if (!launch) return { accepted: false, duplicate: false, ignored: true };
  const result = flow.observeFlow(book, {
    ...input,
    createSignature: launch.createSignature,
    inCreateTransaction: input.inCreateTransaction === true || input.txSignature === launch.createSignature,
    isCreator: input.wallet && launch.creator ? input.wallet === launch.creator : input.isCreator,
    isDeployer: input.wallet && launch.deployer ? input.wallet === launch.deployer : input.isDeployer,
    quoteMint: input.quoteMint || launch.quoteMint || null,
  });
  if (result.accepted) append({ type: "wallet_flow_event", ...result.event });
  else if (result.duplicate) append({ type: "wallet_flow_source", txSignature: input.txSignature, mint: input.mint, source: input.source, observedAt: input.observedAt });
  return result;
}

const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

function noteWireTransaction(input) {
  load();
  if (!input || !input.bytes) return [];
  let tx;
  try {
    tx = require("@solana/web3.js").VersionedTransaction.deserialize(input.bytes);
  } catch {
    return [];
  }
  const keys = tx.message.staticAccountKeys.map((key) => key.toBase58());
  const numSigners = tx.message.header.numRequiredSignatures;
  const out = [];
  for (const ix of tx.message.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    if (program !== PUMP_PROGRAM_ID) continue;
    const accountKeys = [];
    let unresolved = false;
    for (const index of ix.accountKeyIndexes) {
      if (!keys[index]) {
        unresolved = true;
        break;
      }
      accountKeys.push(keys[index]);
    }
    if (unresolved) continue;
    const parsed = flow.flowFromBuyInstruction(accountKeys, Buffer.from(ix.data), numSigners);
    if (!parsed || !parsed.mint || !book.launches.has(parsed.mint)) continue;
    out.push(
      noteFlow({
        mint: parsed.mint,
        wallet: parsed.wallet,
        side: parsed.side,
        quoteAmount: parsed.wireSol,
        quoteRaw: parsed.quoteRaw,
        tokenAmount: parsed.tokenRaw != null ? parsed.tokenRaw / 1e6 : null,
        eventConfidence: parsed.eventConfidence,
        txSignature: input.txSignature || null,
        chainSlot: input.slot,
        source: input.source,
        observedAt: input.observedAt,
        inCreateTransaction: input.inCreateTransaction === true,
      })
    );
  }
  return out;
}

function noteLogs(input) {
  const logs = (input && input.logs) || [];
  const out = [];
  for (const line of logs) {
    const parsed = flow.parseTradeEventLog(line);
    if (!parsed) continue;
    out.push(noteFlow({
      mint: parsed.mint,
      wallet: parsed.wallet,
      side: parsed.side,
      quoteRaw: parsed.quoteRaw,
      tokenRaw: parsed.tokenRaw,
      tokenAmount: parsed.tokenRaw != null ? parsed.tokenRaw / 1e6 : null,
      eventConfidence: parsed.eventConfidence,
      txSignature: input.txSignature,
      chainSlot: input.slot,
      source: input.source,
      observedAt: input.observedAt,
      inCreateTransaction: input.inCreateTransaction === true,
    }));
  }
  return out;
}

function getBook() {
  load();
  return book;
}

function resetForTests() {
  book.launches.clear();
  book.events.clear();
  loaded = true;
}

module.exports = {
  noteCandidate,
  noteDecision,
  noteFlow,
  noteLogs,
  noteWireTransaction,
  getBook,
  setTracePath,
  resetForTests,
  defaultTracePath,
};
