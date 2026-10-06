/**
 * Timing-frontier report. Research only.
 * Frozen horizons: current, 100, 250, 500, 750, 1000, 1500, 2000.
 * A research verdict cannot promote live, move the cutoff, or change a gate.
 */
"use strict";

const tf = require("./timing-frontier-v1");
const collector = require("./timing-frontier-collector");

function fmt(v) {
  if (v == null || typeof v !== "number" || !Number.isFinite(v)) return "na";
  return String(Math.round(v * 1000) / 1000);
}

function formatReport(result) {
  const lines = [];
  lines.push("timing-frontier");
  lines.push("featureVersion " + result.featureVersion);
  lines.push("researchBuySol " + result.researchBuySol);
  lines.push("externalTargetSetVersion " + result.externalTargetSetVersion);
  lines.push("externalTargetSnapshotAt " + result.externalTargetSnapshotAt);
  lines.push("externalTargetMatchesExpected " + result.externalTargetMatchesExpected);
  lines.push("verdict " + result.verdict);
  lines.push("liveStatus " + result.liveStatus);
  lines.push("liveTrading " + result.liveTrading);
  lines.push("kill " + result.kill);
  lines.push("shadowCanPromoteLive " + result.shadowCanPromoteLive);
  lines.push("pass " + result.pass);
  lines.push("V3 risk was not retrained. risk-low subgroup is the non-mayhem timing sample.");
  const header = [
    "Horizon",
    "EligibleN",
    "IndependentFlow",
    "rhoPnl",
    "rhoMfe",
    "Top5MedianPnl",
    "Runner10",
    "EntryPremium",
    "MedianPnl",
    "MAE",
  ];
  lines.push(header.join("\t"));
  for (const horizon of tf.HORIZONS) {
    const row = result.horizons[horizon];
    lines.push([
      horizon,
      row.eligibleN,
      fmt(row.independentFlowCoverage),
      row.rhoPnl.map(fmt).join(",") || "na",
      row.rhoMfe.map(fmt).join(",") || "na",
      row.top5MedianPnl.map(fmt).join(",") || "na",
      fmt(row.runner10),
      fmt(row.entryPremiumMedian),
      fmt(row.medianPnl),
      fmt(row.mae),
    ].join("\t"));
    lines.push(
      "detail " + horizon +
      " featureRows " + row.featureRows +
      " fit " + (row.fitFeatures.join(",") || "none") +
      " premiumP50 " + fmt(row.entryPremiumP50) +
      " premiumP90 " + fmt(row.entryPremiumP90) +
      " trimmedPnl " + fmt(row.trimmedPnl) +
      " mfe " + fmt(row.mfe) +
      " catastrophic " + fmt(row.catastrophic)
    );
    if (row.fomo) {
      lines.push(
        "fomo " + horizon +
        " eligible " + row.fomo.eligibleLaunches +
        " anyF1 " + row.fomo.anyF1 +
        " anyF2 " + row.fomo.anyF2 +
        " anyF3 " + row.fomo.anyF3 +
        " f1Cluster2 " + row.fomo.f1Cluster2 +
        " f2Cluster2 " + row.fomo.f2Cluster2 +
        " f3Cluster2 " + row.fomo.f3Cluster2 +
        " medianFirstTargetArrival " + fmt(row.fomo.medianFirstTargetArrivalMs) +
        " medianSecondTargetArrival " + fmt(row.fomo.medianSecondTargetArrivalMs) +
        " baselineMedianPnl " + fmt(row.fomo.baseline.medianPnl) +
        " targetBuyerMedianPnl " + fmt(row.fomo.targetBuyer.medianPnl) +
        " clusterMedianPnl " + fmt(row.fomo.cluster.medianPnl) +
        " entryPremiumBeforeTarget " + fmt(row.fomo.entryPremiumBeforeTarget) +
        " targetMFE " + fmt(row.fomo.targetBuyer.mfe) +
        " targetMAE " + fmt(row.fomo.targetBuyer.mae) +
        " targetRunner10 " + fmt(row.fomo.targetBuyer.runner10)
      );
    }
  }
  lines.push("mayhem is reported separately and is not an opportunity feature.");
  for (const horizon of ["current", "1000", "2000"]) {
    const row = result.mayhemSeparate[horizon];
    lines.push("mayhem " + horizon + " eligible " + row.eligibleN + " medianPnl " + fmt(row.medianPnl));
  }
  for (const name of Object.keys(result.models)) {
    const model = result.models[name];
    const folds = model.walk.folds || [];
    lines.push(
      name +
      " folds " + folds.length +
      " researchPass " + model.strict.pass +
      " reason " + model.strict.reason +
      " livePromotion " + model.livePromotion +
      " rho " + folds.map((f) => fmt(f.rhoPnl)).join(",")
    );
  }
  const listener = result.listener;
  lines.push(
    "listener paired " + listener.paired +
    " leadP10 " + fmt(listener.leadP10) +
    " leadP50 " + fmt(listener.leadP50) +
    " leadP90 " + fmt(listener.leadP90) +
    " geyserConfigured " + listener.geyserConfigured +
    " logsWithoutPreprocessed " + listener.logsWithoutPreprocessed +
    " preprocessedWithoutLogs " + listener.preprocessedWithoutLogs +
    " firstShare " + JSON.stringify(listener.sourceFirstShare)
  );
  lines.push("live_selected remains COLLECT. This report cannot promote live.");
  lines.push("Fomo target study is research-only and cannot promote live.");
  return lines.join("\n");
}

function main() {
  const result = tf.evaluateBook(collector.getBook());
  const text = formatReport(result);
  tf.assertNoLivePromotion(text);
  console.log(text);
}

if (require.main === module) main();

module.exports = { formatReport, main };
