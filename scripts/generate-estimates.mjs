import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  buildCohortEstimates,
  buildPooledNationalityServices,
  forecastHierarchicalCapacity,
} from "./estimation-model.mjs";

const configPath = resolve(
  process.cwd(),
  process.argv[2] ?? "config/estimator.json",
);
const config = JSON.parse(readFileSync(configPath, "utf8"));
const sourcePath = resolve(process.cwd(), config.sourceFile);
const outputPath = resolve(process.cwd(), config.outputFile);
const namesOutputPath = resolve(process.cwd(), config.namesFile);
const codebookPath = resolve(process.cwd(), config.codebookFile);
const sourceBuffer = readFileSync(sourcePath);
const sourceText = sourceBuffer[0] === 0x1f && sourceBuffer[1] === 0x8b
  ? gunzipSync(sourceBuffer).toString("utf8")
  : sourceBuffer.toString("utf8");
const source = JSON.parse(sourceText);
const HISTORY_MONTHS = Number(config.historyMonths);
const ROLLING_WINDOW = Number(config.rollingWindowMonths);
const SUPPRESSION_THRESHOLD = Number(config.suppressionThreshold);
const MAX_PROJECTION_MONTHS = Number(config.maxProjectionMonths);
const MODEL_OPTIONS = {
  shortWindowMonths: ROLLING_WINDOW,
  ...config.model,
};

function parsePeriod(period) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!match) throw new Error(`Invalid month mapping period: ${period}`);
  return Number(match[1]) * 12 + Number(match[2]) - 1;
}

const anchorMonthId = Number(config.monthMapping?.anchorId);
const anchorAbsoluteMonth = parsePeriod(config.monthMapping?.anchorPeriod);

function periodFromMonthId(monthId) {
  const offset = Number(monthId) - anchorMonthId;
  const absoluteMonth = anchorAbsoluteMonth + offset;
  const year = Math.floor(absoluteMonth / 12);
  const month = (absoluteMonth % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

function collectLeaves(node, levels = [], groupCodes = [], target = new Map()) {
  const children = node?.children && typeof node.children === "object"
    ? Object.entries(node.children)
    : [];

  if (children.length === 0) {
    if (levels.length > 0) {
      target.set(levels.join("/"), {
        levels,
        groupCodes,
        count: Number(node?.count ?? 0),
        nationalities: Object.fromEntries(
          Object.entries(node?.nationalities ?? {}).map(([id, item]) => [
            id,
            Number(item?.count ?? 0),
          ]),
        ),
      });
    }
    return target;
  }

  for (const [id, child] of children) {
    collectLeaves(
      child,
      [...levels, id],
      [...groupCodes, String(child?.group ?? "UNKNOWN")],
      target,
    );
  }
  return target;
}

function buildSeries(section, monthIds) {
  const result = new Map();

  monthIds.forEach((monthId, index) => {
    const leaves = collectLeaves(section[monthId]);
    for (const [path, leaf] of leaves) {
      if (!result.has(path)) {
        result.set(path, {
          levels: leaf.levels,
          groupCodes: leaf.groupCodes,
          counts: Array(monthIds.length).fill(0),
          nationalityCounts: new Map(),
        });
      }
      const series = result.get(path);
      series.counts[index] = leaf.count;
      for (const [nationalityId, count] of Object.entries(leaf.nationalities)) {
        if (!series.nationalityCounts.has(nationalityId)) {
          series.nationalityCounts.set(
            nationalityId,
            Array(monthIds.length).fill(0),
          );
        }
        series.nationalityCounts.get(nationalityId)[index] = count;
      }
    }
  });

  return result;
}

function readExistingHierarchy(path) {
  try {
    const config = JSON.parse(readFileSync(path, "utf8"));
    return config?.hierarchy && typeof config.hierarchy === "object"
      ? config.hierarchy
      : {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function readOfficialCodebook(path) {
  try {
    const codebook = JSON.parse(readFileSync(path, "utf8"));
    return {
      groups: codebook?.groups && typeof codebook.groups === "object"
        ? codebook.groups
        : {},
      countries: codebook?.countries && typeof codebook.countries === "object"
        ? codebook.countries
        : {},
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { groups: {}, countries: {} };
    throw error;
  }
}

function buildNameHierarchy(applicationPaths, existingHierarchy, officialNames) {
  const hierarchy = {};
  const entries = [...applicationPaths.values()].sort((left, right) =>
    left.levels.join("/").localeCompare(right.levels.join("/"), undefined, {
      numeric: true,
    }),
  );

  for (const entry of entries) {
    let generatedChildren = hierarchy;
    let existingChildren = existingHierarchy;

    for (let levelIndex = 0; levelIndex < entry.levels.length; levelIndex += 1) {
      const id = entry.levels[levelIndex];
      const groupCode = entry.groupCodes[levelIndex];
      const existingNode = existingChildren?.[id];
      if (!generatedChildren[id]) {
        const existingName = typeof existingNode?.name === "string"
          ? existingNode.name.trim()
          : "";
        const officialName = officialNames?.[groupCode]?.[id];
        generatedChildren[id] = {
          name: existingName || officialName || "",
          children: {},
        };
      }

      generatedChildren = generatedChildren[id].children;
      existingChildren = existingNode?.children && typeof existingNode.children === "object"
        ? existingNode.children
        : {};
    }
  }

  return hierarchy;
}

function countHierarchyNodes(children) {
  return Object.values(children).reduce(
    (total, node) => total + 1 + countHierarchyNodes(node.children ?? {}),
    0,
  );
}

function addSeries(target, source) {
  for (let index = 0; index < target.length; index += 1) {
    target[index] += Number(source[index] || 0);
  }
}

function subtractSeries(left, right) {
  return left.map((value, index) => Math.max(
    0,
    Number(value || 0) - Number(right[index] || 0),
  ));
}

function buildPrefixTotals(seriesByPath, length) {
  const totals = new Map([["", Array(length).fill(0)]]);
  for (const series of seriesByPath.values()) {
    addSeries(totals.get(""), series.counts);
    for (let prefixLength = 1; prefixLength < series.levels.length; prefixLength += 1) {
      const prefix = series.levels.slice(0, prefixLength).join("/");
      if (!totals.has(prefix)) totals.set(prefix, Array(length).fill(0));
      addSeries(totals.get(prefix), series.counts);
    }
  }
  return totals;
}

function relatedSeriesFor(series, prefixTotals) {
  const parentPrefix = series.levels.slice(0, -1).join("/");
  return subtractSeries(
    prefixTotals.get(parentPrefix) ?? prefixTotals.get(""),
    series.counts,
  );
}

const monthIds = Object.keys(source.applications).sort((a, b) => Number(a) - Number(b));
const decisionMonthIds = Object.keys(source.decisions).sort((a, b) => Number(a) - Number(b));

if (monthIds.length === 0 || monthIds.join(",") !== decisionMonthIds.join(",")) {
  throw new Error("Application and decision month IDs must be present and aligned.");
}

const months = monthIds.map((monthId) => ({
  id: monthId,
  period: periodFromMonthId(monthId),
}));
const targetMonthIndexes = months
  .map((month, index) => ({ ...month, index }))
  .slice(-HISTORY_MONTHS);

const applicationsByPath = buildSeries(source.applications, monthIds);
const decisionsByPath = buildSeries(source.decisions, monthIds);
const applicationPrefixTotals = buildPrefixTotals(
  applicationsByPath,
  monthIds.length,
);
const decisionPrefixTotals = buildPrefixTotals(
  decisionsByPath,
  monthIds.length,
);
const globalApplicationCounts = applicationPrefixTotals.get("");
const globalDecisionCounts = decisionPrefixTotals.get("");
const officialCodebook = readOfficialCodebook(codebookPath);
const nameHierarchy = buildNameHierarchy(
  applicationsByPath,
  readExistingHierarchy(namesOutputPath),
  officialCodebook.groups,
);
const paths = [...new Set([...applicationsByPath.keys(), ...decisionsByPath.keys()])]
  .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

const estimates = [];
const includedNationalityIds = new Set();

for (const path of paths) {
  const application = applicationsByPath.get(path);
  const decision = decisionsByPath.get(path);
  if (!application) continue;

  const applicationCounts = application.counts;
  const decisionCounts = decision?.counts ?? Array(monthIds.length).fill(0);
  const relatedApplications = relatedSeriesFor(
    application,
    applicationPrefixTotals,
  );
  const relatedDecisions = decision
    ? relatedSeriesFor(decision, decisionPrefixTotals)
    : decisionPrefixTotals.get(
      application.levels.slice(0, -1).join("/"),
    ) ?? globalDecisionCounts;
  const capacityModel = forecastHierarchicalCapacity({
    decisions: decisionCounts,
    relatedDecisions,
    globalDecisions: subtractSeries(globalDecisionCounts, decisionCounts),
    options: MODEL_OPTIONS,
  });
  const applicationModel = forecastHierarchicalCapacity({
    decisions: applicationCounts,
    relatedDecisions: relatedApplications,
    globalDecisions: subtractSeries(globalApplicationCounts, applicationCounts),
    options: MODEL_OPTIONS,
  });
  const commonEstimateOptions = {
    targetMonths: targetMonthIndexes,
    recentWindowMonths: ROLLING_WINDOW,
    suppressionThreshold: SUPPRESSION_THRESHOLD,
    maxProjectionMonths: MAX_PROJECTION_MONTHS,
    fifoPriorityShare: MODEL_OPTIONS.fifoPriorityShare,
    softFifoAgePower: MODEL_OPTIONS.softFifoAgePower,
  };
  const byMonth = buildCohortEstimates({
    applications: applicationCounts,
    observedCapacity: decisionCounts,
    capacityForecast: (offset, variant) => capacityModel.valueAt(offset, variant),
    applicationForecast: (offset) => applicationModel.valueAt(offset),
    reliability: capacityModel.reliability,
    ...commonEstimateOptions,
  });

  if (Object.values(byMonth).every((value) => value === null)) continue;

  const nationalityEstimates = {};
  const pooledNationalityServices = buildPooledNationalityServices({
    applicationSeries: application.nationalityCounts,
    decisionSeries: decision?.nationalityCounts ?? new Map(),
    totalApplications: applicationCounts,
    totalDecisions: decisionCounts,
    options: MODEL_OPTIONS,
  });
  for (const [nationalityId, nationalityService] of pooledNationalityServices) {
    const nationalityApplications = application.nationalityCounts.get(nationalityId)
      ?? Array(monthIds.length).fill(0);
    const byNationalityMonth = buildCohortEstimates({
      applications: nationalityApplications,
      observedCapacity: nationalityService.counts,
      capacityForecast: (offset, variant) => (
        capacityModel.valueAt(offset, variant)
        * nationalityService.shareAt(offset)
      ),
      applicationForecast: (offset) => (
        applicationModel.valueAt(offset)
        * nationalityService.latestDemandShare
      ),
      reliability: nationalityService.latestReliability,
      ...commonEstimateOptions,
    });
    const availableEntries = Object.entries(byNationalityMonth)
      .filter(([, value]) => value !== null);

    if (availableEntries.length > 0) {
      nationalityEstimates[nationalityId] = Object.fromEntries(availableEntries);
      includedNationalityIds.add(nationalityId);
    }
  }

  estimates.push({
    path,
    levels: application.levels,
    groupCodes: application.groupCodes,
    estimates: byMonth,
    nationalityEstimates,
  });
}

const nationalityNames = Object.fromEntries(
  [...includedNationalityIds]
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .map((id) => [id, officialCodebook.countries[id] || `Citizenship ID ${id}`]),
);

const output = {
  metadata: {
    sourceFile: basename(sourcePath),
    sourceBytes: Buffer.byteLength(sourceText),
    sourceThrough: months.at(-1).period,
    monthMapping: config.monthMapping.status,
    historyMonths: HISTORY_MONTHS,
    rollingWindowMonths: ROLLING_WINDOW,
    suppressionThreshold: SUPPRESSION_THRESHOLD,
    model: "Hierarchical shared-capacity soft-FIFO cohort model",
    modelVersion: 2,
    capacityModel: "Empirical-Bayes dynamic capacity with sibling and global throughput signals",
    nationalityModel: "Partially pooled allocation of shared category capacity",
    fifoPriorityShare: MODEL_OPTIONS.fifoPriorityShare,
  },
  months: targetMonthIndexes.map(({ id, period }) => ({ id, period })),
  nationalities: nationalityNames,
  paths: estimates,
};

writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
writeFileSync(
  namesOutputPath,
  `${JSON.stringify({ hierarchy: nameHierarchy }, null, 2)}\n`,
  "utf8",
);
console.log(
  `Generated ${estimates.length} estimable paths and ${countHierarchyNodes(nameHierarchy)} taxonomy nodes through ${output.metadata.sourceThrough}`,
);
