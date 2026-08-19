import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import {
  forecastDynamicNationalityCapacityShares,
  forecastHierarchicalCapacity,
  forecastNationalityCapacityShares,
  reconstructNationalityBacklogs,
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

test("nationality capacity shares divide one service pool", () => {
  const shares = forecastNationalityCapacityShares({
    applicationSeries: new Map([
      ["russia", Array(12).fill(50)],
      ["bangladesh", Array(12).fill(50)],
    ]),
    decisionSeries: new Map([
      ["russia", Array(12).fill(80)],
      ["bangladesh", Array(12).fill(20)],
    ]),
    options,
  });

  assert.ok(
    shares.centralShares.get("russia")
      > shares.centralShares.get("bangladesh"),
  );
  for (const offset of [0, 1, 12, 120]) {
    const totalShare = shares.shareAt("russia", offset)
      + shares.shareAt("bangladesh", offset);
    assert.ok(Math.abs(totalShare - 1) < 1e-9);
  }
  assert.ok(
    shares.shareAt("russia", 120)
      < shares.shareAt("russia", 0),
  );
});

test("dynamic nationality shares are normalized and ignore future observations", () => {
  const applicationSeries = new Map([
    ["russia", [30, 30, 30, 30, 30, 30, 45, 45, 45, 45, 45, 45, 999]],
    ["india", [70, 70, 70, 70, 70, 70, 55, 55, 55, 55, 55, 55, 0]],
  ]);
  const decisionSeries = new Map([
    ["russia", [20, 20, 20, 20, 20, 20, 35, 35, 35, 35, 35, 35, 999]],
    ["india", [80, 80, 80, 80, 80, 80, 65, 65, 65, 65, 65, 65, 0]],
  ]);
  const model = forecastDynamicNationalityCapacityShares({
    applicationSeries,
    decisionSeries,
    throughIndex: 11,
    options,
  });
  const truncated = forecastDynamicNationalityCapacityShares({
    applicationSeries: new Map([...applicationSeries].map(([id, values]) => [
      id,
      values.slice(0, 12),
    ])),
    decisionSeries: new Map([...decisionSeries].map(([id, values]) => [
      id,
      values.slice(0, 12),
    ])),
    options,
  });

  for (const offset of [0, 1, 6, 24]) {
    const total = model.shareAt("russia", offset)
      + model.shareAt("india", offset);
    assert.ok(Math.abs(total - 1) < 1e-9);
    assert.ok(model.shareAt("russia", offset) >= 0);
    assert.ok(model.shareAt("india", offset) >= 0);
  }
  assert.ok(
    Math.abs(model.shareAt("russia", 0) - truncated.shareAt("russia", 0))
      < 1e-12,
  );
  assert.ok(
    Math.abs(model.shareAt("russia", 12) - truncated.shareAt("russia", 12))
      < 1e-12,
  );
});

test("nationality backlog reconstruction preserves case identity and checkpoints", () => {
  const applicationSeries = new Map([
    ["russia", [1, 0, 0, 0]],
    ["bangladesh", [10, 10, 0, 0]],
  ]);
  const decisionSeries = new Map([
    ["russia", [3, 0, 0, 0]],
    ["bangladesh", [0, 0, 5, 0]],
  ]);
  const reconstruction = reconstructNationalityBacklogs({
    applicationSeries: new Map([
      ...applicationSeries,
    ]),
    decisionSeries: new Map([
      ...decisionSeries,
    ]),
    checkpoints: [
      {
        index: 1,
        pendingApplications: 14,
        relation: "approximate",
        label: "early estimate",
      },
      {
        index: 2,
        pendingApplications: 23,
        relation: "exact",
        label: "exact anchor",
      },
      {
        index: 3,
        pendingApplications: 18,
        relation: "minimum",
        label: "lower bound",
      },
    ],
    seedWeights: new Map([
      ["russia", 1],
      ["bangladesh", 10],
    ]),
    constraintsThroughIndex: 4,
  });

  assert.equal(reconstruction.requiredInitialBacklog, 5);
  assert.equal(reconstruction.minimumRequiredInitialBacklog, 2);
  assert.equal(reconstruction.initialBacklogs.get("russia"), 2);
  assert.equal(reconstruction.initialBacklogs.get("bangladesh"), 3);
  assert.equal(reconstruction.checkpointBacklogs.get("russia"), 0);
  assert.equal(reconstruction.checkpointBacklogs.get("bangladesh"), 23);
  assert.equal(reconstruction.reconstructedCheckpoint, 23);
  assert.equal(reconstruction.minimumBacklog, 0);
  assert.deepEqual(
    reconstruction.checkpointResults.map((checkpoint) => ({
      label: checkpoint.label,
      reconstructed: checkpoint.reconstructed,
      residual: checkpoint.residual,
      satisfied: checkpoint.satisfied,
    })),
    [
      {
        label: "early estimate",
        reconstructed: 13,
        residual: -1,
        satisfied: null,
      },
      {
        label: "exact anchor",
        reconstructed: 23,
        residual: 0,
        satisfied: true,
      },
      {
        label: "lower bound",
        reconstructed: 18,
        residual: 0,
        satisfied: true,
      },
    ],
  );

  assert.throws(() => reconstructNationalityBacklogs({
    applicationSeries,
    decisionSeries,
    checkpointIndex: 2,
    pendingApplications: 19,
    seedWeights: new Map([
      ["russia", 1],
      ["bangladesh", 10],
    ]),
    constraintsThroughIndex: 4,
  }), /require 2 opening cases, but the checkpoint permits only 1/);
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

test("soft FIFO services pre-existing backlog before observed cohorts", () => {
  const common = {
    applications: [10, 10],
    observedCapacity: [5, 5],
    targetIndexes: [1],
    futureCapacityAt: () => 5,
    futureApplicationsAt: () => 0,
    maxProjectionMonths: 12,
    fifoPriorityShare: 0.9,
    softFifoAgePower: 2,
  };
  const withoutSeed = simulateSoftFifoCohorts(common).get(1);
  const withSeed = simulateSoftFifoCohorts({
    ...common,
    initialBacklog: 10,
  }).get(1);

  assert.ok(withoutSeed);
  assert.ok(withSeed);
  assert.ok(withSeed.months > withoutSeed.months);
  assert.ok(withSeed.observedShare < withoutSeed.observedShare);
});

test("dynamic spouse shares improve the frozen 2022-2026 holdout", async () => {
  const compressed = await readFile(new URL(
    "../data/source/migri-statistics.json.gz",
    import.meta.url,
  ));
  const source = JSON.parse(gunzipSync(compressed).toString("utf8"));
  const monthIds = Object.keys(source.decisions)
    .sort((left, right) => Number(left) - Number(right));
  const path = ["21205", "59", "1", "133"];

  function nodeAt(section, monthId) {
    let node = section[monthId];
    for (const id of path) node = node.children[id];
    return node;
  }

  function countrySeries(section) {
    const result = new Map();
    monthIds.forEach((monthId, index) => {
      for (const [id, item] of Object.entries(
        nodeAt(section, monthId).nationalities ?? {},
      )) {
        if (!result.has(id)) result.set(id, Array(monthIds.length).fill(0));
        result.get(id)[index] = Number(item?.count ?? 0);
      }
    });
    return result;
  }

  const applications = countrySeries(source.applications);
  const decisions = countrySeries(source.decisions);
  const ids = [...new Set([...applications.keys(), ...decisions.keys()])];
  const [anchorYear, anchorMonth] = config.monthMapping.anchorPeriod
    .split("-").map(Number);
  const evaluationMonthId = Number(config.monthMapping.anchorId)
    + (2022 - anchorYear) * 12 + (1 - anchorMonth);
  const evaluationStart = monthIds.indexOf(String(evaluationMonthId));
  let currentError = 0;
  let dynamicError = 0;
  let months = 0;

  for (let index = evaluationStart; index < monthIds.length; index += 1) {
    const actualTotal = ids.reduce((total, id) => (
      total + Number(decisions.get(id)?.[index] || 0)
    ), 0);
    if (actualTotal <= 0) continue;
    const current = forecastNationalityCapacityShares({
      applicationSeries: applications,
      decisionSeries: decisions,
      throughIndex: index - 1,
      options,
    });
    const dynamic = forecastDynamicNationalityCapacityShares({
      applicationSeries: applications,
      decisionSeries: decisions,
      throughIndex: index - 1,
      options,
    });
    for (const id of ids) {
      const actualShare = Number(decisions.get(id)?.[index] || 0) / actualTotal;
      currentError += Math.abs(current.shareAt(id, 0) - actualShare) / 2;
      dynamicError += Math.abs(dynamic.shareAt(id, 0) - actualShare) / 2;
    }
    months += 1;
  }

  assert.equal(months, 55);
  assert.ok(dynamicError / months < currentError / months * 0.85);
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
