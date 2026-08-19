import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gunzipSync } from "node:zlib";

const dataUrl = new URL("../data/estimates.json", import.meta.url);
const typeNamesUrl = new URL("../config/type-names.json", import.meta.url);
const codebookUrl = new URL("../config/migri-codebook.en.json", import.meta.url);
const configUrl = new URL("../config/estimator.json", import.meta.url);

async function readConfiguredSource() {
  const config = JSON.parse(await readFile(configUrl, "utf8"));
  const sourceUrl = new URL(`../${config.sourceFile}`, import.meta.url);
  const externalAnchorsUrl = new URL(
    `../${config.externalAnchorsFile}`,
    import.meta.url,
  );
  const [compressed, externalAnchors] = await Promise.all([
    readFile(sourceUrl),
    readFile(externalAnchorsUrl, "utf8").then(JSON.parse),
  ]);
  return {
    config,
    externalAnchors,
    source: JSON.parse(gunzipSync(compressed).toString("utf8")),
  };
}

function hierarchyNode(hierarchy, levels) {
  let children = hierarchy;
  let node;
  for (const id of levels) {
    node = children[id];
    if (!node) return undefined;
    children = node.children;
  }
  return node;
}

test("generated estimator data has the expected shape", async () => {
  const [data, configuredSource] = await Promise.all([
    readFile(dataUrl, "utf8").then(JSON.parse),
    readConfiguredSource(),
  ]);
  const sourceMonthIds = Object.keys(configuredSource.source.applications)
    .sort((left, right) => Number(left) - Number(right));
  const expectedMonthIds = sourceMonthIds.slice(-configuredSource.config.historyMonths);
  const sourceUrl = new URL(configuredSource.config.sourceUrl);

  assert.equal(sourceUrl.protocol, "https:");
  assert.ok(!configuredSource.config.sourceFile.split("/").includes(".."));
  assert.ok(
    !configuredSource.config.externalAnchorsFile.split("/").includes(".."),
  );
  assert.equal(data.metadata.historyMonths, configuredSource.config.historyMonths);
  assert.equal(
    data.metadata.rollingWindowMonths,
    configuredSource.config.rollingWindowMonths,
  );
  assert.equal(
    data.metadata.suppressionThreshold,
    configuredSource.config.suppressionThreshold,
  );
  assert.equal(data.metadata.modelVersion, 5);
  assert.match(data.metadata.model, /hierarchical/i);
  assert.match(data.metadata.initialBacklogModel, /published-checkpoint/i);
  assert.equal(
    data.metadata.externalBacklogAnchors.totalAnchors,
    configuredSource.externalAnchors.anchors.length,
  );
  assert.equal(data.metadata.externalBacklogAnchors.totalAnchors, 27);
  assert.deepEqual(data.metadata.externalBacklogAnchors.dispositions, {
    calibration: 6,
    diagnostic: 15,
    deferred: 2,
    excluded: 4,
  });
  assert.equal(
    data.metadata.externalBacklogAnchors.mappings.reduce(
      (total, mapping) => total + mapping.anchors.length,
      0,
    ),
    data.metadata.externalBacklogAnchors.totalAnchors,
  );
  assert.deepEqual(
    data.metadata.externalBacklogAnchors.mappings.map(({ id }) => id).sort(),
    configuredSource.config.externalAnchorMappings.map(({ id }) => id).sort(),
  );
  assert.equal(data.metadata.backlogCalibrations.length, 1);
  const familyCalibration = data.metadata.backlogCalibrations[0];
  assert.equal(familyCalibration.anchorMappingId, "family-ties");
  assert.equal(familyCalibration.seedPeriod, "2015-01");
  assert.equal(familyCalibration.checkpointPeriod, "2025-11");
  assert.equal(familyCalibration.pendingApplications, 18_200);
  assert.deepEqual(
    familyCalibration.checkpoints.map((checkpoint) => ({
      period: checkpoint.period,
      pendingApplications: checkpoint.pendingApplications,
      relation: checkpoint.relation,
    })),
    [
      { period: "2022-10", pendingApplications: 10_500, relation: "approximate" },
      { period: "2023-05", pendingApplications: 10_800, relation: "approximate" },
      { period: "2023-12", pendingApplications: 11_800, relation: "approximate" },
      { period: "2025-02", pendingApplications: 15_000, relation: "minimum" },
      { period: "2025-06", pendingApplications: 15_000, relation: "minimum" },
      { period: "2025-11", pendingApplications: 18_200, relation: "approximate" },
    ],
  );
  const approximateCheckpoints = familyCalibration.checkpoints.filter(
    (checkpoint) => checkpoint.relation === "approximate",
  );
  assert.ok(approximateCheckpoints.every(
    (checkpoint) => Math.abs(checkpoint.relativeResidual) < 0.1,
  ));
  const minimumCheckpoints = familyCalibration.checkpoints.filter(
    (checkpoint) => checkpoint.relation === "minimum",
  );
  assert.equal(minimumCheckpoints.length, 2);
  assert.ok(minimumCheckpoints.every((checkpoint) => checkpoint.satisfied));
  assert.ok(minimumCheckpoints.every((checkpoint) => checkpoint.residual >= 0));
  assert.equal(familyCalibration.estimatedInitialBacklog, 7_803.75);
  assert.ok(familyCalibration.minimumRequiredInitialBacklog >= 0);
  assert.ok(
    familyCalibration.minimumRequiredInitialBacklog
      <= familyCalibration.estimatedInitialBacklog,
  );
  assert.equal(
    familyCalibration.discretionaryInitialBacklog,
    familyCalibration.estimatedInitialBacklog
      - familyCalibration.minimumRequiredInitialBacklog,
  );
  assert.equal(familyCalibration.checkpointResidual, 237.75);
  assert.equal(familyCalibration.minimumQueueBalance, 0);
  assert.equal(
    familyCalibration.estimatedInitialBacklog
      + familyCalibration.netFlowAtCheckpoint,
    familyCalibration.reconstructedAtCheckpoint,
  );
  assert.equal(
    familyCalibration.reconstructedAtCheckpoint
      - familyCalibration.pendingApplications,
    familyCalibration.checkpointResidual,
  );
  assert.ok(familyCalibration.constrainedNationalityCount > 0);
  assert.ok(familyCalibration.bindingNationalityCount > 0);
  assert.equal(
    familyCalibration.constrainedThroughPeriod,
    data.metadata.sourceThrough,
  );
  const allocatedSeed = data.paths
    .filter((path) => familyCalibration.scopePrefixes.some((prefix) => (
      path.path === prefix || path.path.startsWith(`${prefix}/`)
    )))
    .reduce((total, path) => total + path.initialBacklog, 0);
  assert.ok(
    Math.abs(allocatedSeed - familyCalibration.estimatedInitialBacklog) < 0.2,
  );
  assert.match(data.metadata.nationalityModel, /never consume another citizenship/i);
  assert.ok(!("nationalityAdjustmentBounds" in data.metadata));
  assert.equal(
    data.metadata.fifoPriorityShare,
    configuredSource.config.model.fifoPriorityShare,
  );
  assert.deepEqual(data.months.map((month) => month.id), expectedMonthIds);
  assert.ok(Object.keys(data.nationalities).length > 0);
  assert.ok(data.paths.length > 0);
  assert.ok(data.paths.every((item) => item.path === item.levels.join("/")));
  assert.ok(data.paths.every((item) => typeof item.nationalityEstimates === "object"));
});

test("the requested residence-permit path is included", async () => {
  const data = JSON.parse(await readFile(dataUrl, "utf8"));
  const requested = data.paths.find((item) => item.path === "21205/59/1/133");
  const firstPeriod = data.months[0].period;
  const lastPeriod = data.months.at(-1).period;

  assert.ok(requested, "expected path 21205/59/1/133 in generated data");
  assert.ok(requested.initialBacklog > 0);
  assert.ok(requested.initialBacklog < 7_566);
  assert.ok(requested.estimates[firstPeriod]);
  assert.ok(requested.estimates[lastPeriod]);
});

test("nationality-specific estimates use Migri citizenship labels", async () => {
  const [data, codebook] = await Promise.all([
    readFile(dataUrl, "utf8").then(JSON.parse),
    readFile(codebookUrl, "utf8").then(JSON.parse),
  ]);
  const requested = data.paths.find((item) => item.path === "21205/59/1/133");

  assert.equal(data.nationalities["23"], codebook.countries["23"]);
  assert.equal(data.nationalities["23"], "China");
  assert.ok(Object.keys(requested.nationalityEstimates["23"]).length > 0);
});

test("nationality estimates are generated from nationality-preserving queues", async () => {
  const data = JSON.parse(await readFile(dataUrl, "utf8"));
  const requested = data.paths.find((item) => item.path === "21205/59/1/133");
  const period = data.metadata.sourceThrough;
  const available = Object.entries(requested.nationalityEstimates)
    .map(([nationalityId, estimates]) => [nationalityId, estimates[period]])
    .filter(([, estimate]) => estimate);

  assert.ok(available.length > 0, "expected current nationality estimates");
  for (const [nationalityId, estimate] of available) {
    assert.ok(estimate.months > 0);
    assert.ok(estimate.lowerMonths <= estimate.months);
    assert.ok(estimate.upperMonths >= estimate.months);
    assert.ok(data.nationalities[nationalityId]);
  }
});

test("the generated name config contains every estimable hierarchy path", async () => {
  const [data, names] = await Promise.all([
    readFile(dataUrl, "utf8").then(JSON.parse),
    readFile(typeNamesUrl, "utf8").then(JSON.parse),
  ]);

  assert.ok(Object.keys(names.hierarchy).length > 0);
  for (const item of data.paths) {
    const node = hierarchyNode(names.hierarchy, item.levels);
    assert.ok(node, `expected ${item.path} in generated name hierarchy`);
    assert.equal(typeof node.name, "string");
    assert.equal(typeof node.children, "object");
  }
});

test("every generated taxonomy node has an official Migri English name", async () => {
  const [configuredSource, names, codebook] = await Promise.all([
    readConfiguredSource(),
    readFile(typeNamesUrl, "utf8").then(JSON.parse),
    readFile(codebookUrl, "utf8").then(JSON.parse),
  ]);
  const rawData = configuredSource.source;
  const groupByPath = {};

  function collectGroups(node, prefix = []) {
    for (const [id, child] of Object.entries(node?.children ?? {})) {
      const levels = [...prefix, id];
      groupByPath[levels.join("/")] = child.group;
      collectGroups(child, levels);
    }
  }

  for (const month of Object.values(rawData.applications)) collectGroups(month);

  let nodeCount = 0;
  function verifyNames(children, prefix = []) {
    for (const [id, node] of Object.entries(children)) {
      const levels = [...prefix, id];
      const path = levels.join("/");
      const officialName = codebook.groups?.[groupByPath[path]]?.[id];
      const normalized = (value) => value.toLocaleLowerCase().replace(/\s+/g, " ").trim();

      assert.ok(officialName, `expected an official codebook name for ${path}`);
      assert.equal(normalized(node.name), normalized(officialName), `name mismatch for ${path}`);
      nodeCount += 1;
      verifyNames(node.children, levels);
    }
  }

  verifyNames(names.hierarchy);
  assert.equal(nodeCount, 177);
});

test("suppressed cells never expose raw application or decision counts", async () => {
  const source = await readFile(dataUrl, "utf8");

  assert.doesNotMatch(source, /"applications"\s*:/);
  assert.doesNotMatch(source, /"decisions"\s*:/);
});
