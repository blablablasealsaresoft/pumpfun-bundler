/**
 * Optional launch sensors. A missing feed must not crash collection.
 *
 * Shape adapted from:
 *   blablablasealsaresoft/chainstack-pumpfun-bonkfun-bot
 *     src/monitoring/listener_factory.py
 *     src/monitoring/universal_*_listener.py
 * Existing Helius listeners stay the primary path. This module only reconciles
 * observations for research. It does not submit transactions.
 */
"use strict";

const { reconcileObservations } = require("./canonical");

const SENSOR_NAMES = [
  "helius_preprocessed",
  "helius_processed",
  "geyser",
  "logs",
  "blocks",
];

function createSensor(name, startFn) {
  if (!SENSOR_NAMES.includes(name) && name !== "other") {
    throw new Error("unknown sensor " + name);
  }
  let running = false;
  return {
    name,
    async start(onObservation) {
      if (typeof startFn !== "function") {
        throw new Error("sensor " + name + " has no start function");
      }
      running = true;
      await startFn(onObservation);
    },
    async stop() {
      running = false;
    },
    isRunning() {
      return running;
    },
  };
}

/**
 * Optional sensors that are not configured are skipped.
 * @param {Record<string, Function|null|undefined>} starters
 */
function startSensorHub(starters, onCanonical) {
  const byMint = new Map();
  const started = [];
  const skipped = [];

  function ingest(event) {
    if (!event || !event.mint) return null;
    const list = byMint.get(event.mint) || [];
    list.push(event);
    byMint.set(event.mint, list);
    const canonical = reconcileObservations(list);
    if (onCanonical) onCanonical(canonical);
    return canonical;
  }

  for (const name of SENSOR_NAMES) {
    const startFn = starters ? starters[name] : null;
    if (typeof startFn !== "function") {
      skipped.push(name);
      continue;
    }
    const sensor = createSensor(name, async (emit) => {
      await startFn((event) => emit({ ...event, source: name }));
    });
    started.push(sensor);
  }

  return {
    started: started.map((s) => s.name),
    skipped,
    ingest,
    get(mint) {
      return reconcileObservations(byMint.get(mint) || []);
    },
    async startAll() {
      for (const sensor of started) {
        await sensor.start(ingest);
      }
    },
  };
}

module.exports = {
  SENSOR_NAMES,
  createSensor,
  startSensorHub,
};
