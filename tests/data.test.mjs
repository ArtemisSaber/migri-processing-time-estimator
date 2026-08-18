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
  const compressed = await readFile(sourceUrl);
  return {
    config,
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
  assert.equal(data.metadata.historyMonths, configuredSource.config.historyMonths);
  assert.equal(
    data.metadata.rollingWindowMonths,
    configuredSource.config.rollingWindowMonths,
  );
  assert.equal(
    data.metadata.suppressionThreshold,
    configuredSource.config.suppressionThreshold,
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
