/**
 * Timing-frontier coverage. Research only. Does not promote live.
 */
"use strict";

const tf = require("./timing-frontier-v1");
const collector = require("./timing-frontier-collector");

function formatHealth(health) {
  const lines = [];
  lines.push("timing-frontier-health");
  lines.push("featureVersion " + health.featureVersion);
  lines.push("externalTargetSetVersion " + health.externalTargetSetVersion);
  lines.push("externalTargetSnapshotAt " + health.externalTargetSnapshotAt);
  lines.push("externalTargetMatchesExpected " + health.externalTargetMatchesExpected);
  lines.push("externalTargetCounts " + JSON.stringify(health.externalTargetCounts));
  lines.push("launches " + health.launches);
  lines.push("create-state coverage " + health.launchesWithCreateState + "/" + health.launches);
  lines.push("executed TradeEvent coverage " + health.launchesWithTradeState + "/" + health.launches);
  lines.push("launches_total " + health.launches);
  lines.push("launches_with_create_state " + health.launchesWithCreateState);
  lines.push("launches_with_trade_state " + health.launchesWithTradeState);
  lines.push("launches_with_complete_2s_path " + health.launchesWithComplete2sPath);
  lines.push("launches_with_complete_30s_path " + health.launchesWithComplete30sPath);
  lines.push("trade_observations " + health.tradeObservations);
  lines.push("executed_trade_states " + health.executedTradeStates);
  lines.push("duplicate_merges " + health.duplicateMerges);
  lines.push("leakage " + health.leakage);
  lines.push("source_coverage " + JSON.stringify(health.sources));
  lines.push("geyser_configured " + health.geyserConfigured);
  for (const [horizon, row] of Object.entries(health.pathCoverageByHorizon)) {
    lines.push(
      "horizon " + horizon +
      " pathEligible " + row.pathEligible +
      " economic " + row.economic +
      " independentFlow " + row.independentFlow +
      " fomoEligible " + row.fomoEligible +
      " anyF1 " + row.anyF1 +
      " anyF2 " + row.anyF2 +
      " anyF3 " + row.anyF3
    );
  }
  lines.push("liveStatus UNCHANGED");
  lines.push("shadowCanPromoteLive false");
  return lines.join("\n");
}

function main() {
  const health = tf.healthFromBook(collector.getBook());
  const text = formatHealth(health);
  tf.assertNoLivePromotion(text);
  console.log(text);
}

if (require.main === module) main();

module.exports = { formatHealth, main };
