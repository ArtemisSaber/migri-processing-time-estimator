import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import {
  buildPooledNationalityServices,
  forecastHierarchicalCapacity,
  simulateSoftFifoCohorts,
} from "../scripts/estimation-model.mjs";

const configUrl = new URL("../config/estimator.json", import.meta.url);
const config = JSON.parse(await readFile(configUrl, "utf8"));
const options = {
  shortWindowMonths: config.rollingWindowMonths,
  ...config.model,
};

function average(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

test("hierarchical capacity gives sparse series more shared-signal weight", () => {
  const related = [10, 10, 10, 10, 10, 10, 20, 20, 20, 20, 20, 20];
  const global = related.map((value) => value * 10);
  const sparse = forecastHierarchicalCapacity({
    decisions: [1, 1, 1, 1, 1, 1, 2, 1, 2, 1, 2, 1],
    relatedDecisions: related,
    globalDecisions: global,
    options,
  });
  const dense = forecastHierarchicalCapacity({
    decisions: [100, 100, 100, 100, 100, 100, 110, 100, 110, 100, 110, 100],
    relatedDecisions: related,
    globalDecisions: global,
    options,
  });

  assert.ok(sparse.sharedGrowth > 1);
  assert.ok(sparse.reliability < dense.reliability);
  assert.ok(sparse.valueAt(0) > 0);
  assert.ok(sparse.valueAt(0, "low") < sparse.valueAt(0));
  assert.ok(sparse.valueAt(0, "high") > sparse.valueAt(0));
});

test("pooled nationality services conserve category capacity", () => {
  const totalApplications = Array(12).fill(100);
  const totalDecisions = Array(12).fill(100);
  const services = buildPooledNationalityServices({
    applicationSeries: new Map([
      ["a", Array(12).fill(50)],
      ["b", Array(12).fill(50)],
    ]),
    decisionSeries: new Map([
      ["a", Array(12).fill(80)],
      ["b", Array(12).fill(20)],
    ]),
    totalApplications,
    totalDecisions,
    options,
  });

  for (let month = 0; month < totalDecisions.length; month += 1) {
    const allocated = [...services.values()].reduce(
      (total, service) => total + service.counts[month],
      0,
    );
    assert.ok(Math.abs(allocated - totalDecisions[month]) < 1e-8);
  }

  const a = services.get("a");
  const b = services.get("b");
  assert.ok(a.latestShare > 0.5 && a.latestShare < 0.8);
  assert.ok(b.latestShare < 0.5 && b.latestShare > 0.2);
  assert.ok(a.latestReliability <= options.nationalityMaximumWeight);
});

test("soft FIFO favors older cohorts without requiring strict ordering", () => {
  const result = simulateSoftFifoCohorts({
    applications: [10, 10],
    observedCapacity: [5, 5],
    targetIndexes: [0, 1],
    futureCapacityAt: () => 5,
    futureApplicationsAt: () => 0,
    maxProjectionMonths: 12,
    fifoPriorityShare: 0.8,
    softFifoAgePower: 2,
  });
  const older = result.get(0);
  const newer = result.get(1);

  assert.ok(older);
  assert.ok(newer);
  assert.ok(older.months < newer.months);
  assert.ok(older.observedShare > 0);
});

test("hierarchical capacity remains competitive in rolling-origin backtesting", async () => {
  const compressed = await readFile(new URL(
    "../data/source/migri-statistics.json.gz",
    import.meta.url,
  ));
  const source = JSON.parse(gunzipSync(compressed).toString("utf8"));
  const monthIds = Object.keys(source.decisions)
    .sort((left, right) => Number(left) - Number(right));
  const path = ["21205", "59", "1", "133"];

  function nodeAt(monthId, levels) {
    let node = source.decisions[monthId];
    for (const id of levels) node = node.children[id];
    return node;
  }

  const decisions = monthIds.map((monthId) => Number(
    nodeAt(monthId, path).count ?? 0,
  ));
  const relatedDecisions = monthIds.map((monthId, index) => Math.max(
    0,
    Number(nodeAt(monthId, path.slice(0, -1)).count ?? 0) - decisions[index],
  ));
  const globalDecisions = monthIds.map((monthId, index) => Math.max(
    0,
    Number(source.decisions[monthId].count ?? 0) - decisions[index],
  ));
  let hierarchicalError = 0;
  let rollingError = 0;

  for (let throughIndex = 35; throughIndex + 1 < decisions.length; throughIndex += 1) {
    const model = forecastHierarchicalCapacity({
      decisions,
      relatedDecisions,
      globalDecisions,
      throughIndex,
      options,
    });
    const actual = decisions[throughIndex + 1];
    const rolling = average(decisions.slice(
      throughIndex - options.shortWindowMonths + 1,
      throughIndex + 1,
    ));
    hierarchicalError += Math.abs(actual - model.valueAt(0));
    rollingError += Math.abs(actual - rolling);
  }

  // This category is already forecast well by a six-month mean. Hierarchical
  // pooling must add stability without materially sacrificing that baseline.
  assert.ok(hierarchicalError <= rollingError * 1.01);
});
