import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

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

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function rollingCapacity(decisions, window) {
  return mean(decisions.slice(-window));
}

function estimateCohort({
  cohortIndex,
  arrivals,
  decisions,
  queueAhead,
  futureCapacity,
}) {
  if (arrivals <= 0 || futureCapacity <= 0) return null;

  const cohortStart = queueAhead;
  const cohortEnd = queueAhead + arrivals;
  let cumulativeCapacity = 0;
  let processed = 0;
  let observedProcessed = 0;
  let weightedWait = 0;

  for (let offset = 0; offset <= MAX_PROJECTION_MONTHS; offset += 1) {
    const monthIndex = cohortIndex + offset;
    const isObserved = monthIndex < decisions.length;
    const capacity = isObserved ? decisions[monthIndex] : futureCapacity;
    const capacityStart = cumulativeCapacity;
    const capacityEnd = cumulativeCapacity + capacity;
    const cohortProcessed = Math.max(
      0,
      Math.min(capacityEnd, cohortEnd) - Math.max(capacityStart, cohortStart),
    );

    if (cohortProcessed > 0) {
      processed += cohortProcessed;
      weightedWait += cohortProcessed * offset;
      if (isObserved) observedProcessed += cohortProcessed;
    }

    cumulativeCapacity = capacityEnd;
    if (processed >= arrivals - 1e-9) {
      return {
        months: weightedWait / arrivals,
        observedShare: Math.min(1, observedProcessed / arrivals),
      };
    }
  }

  return null;
}

function floorHalf(value) {
  return Math.floor(value * 2) / 2;
}

function ceilHalf(value) {
  return Math.ceil(value * 2) / 2;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function confidenceFor(arrivals, observedShare, recentDecisions) {
  if (arrivals >= 30 && observedShare >= 0.8 && recentDecisions >= 30) return "high";
  if (arrivals >= 12 && recentDecisions >= 18) return "medium";
  return "low";
}

function buildEstimatesByMonth(applicationCounts, decisionCounts, targetMonths) {
  const recentDecisionTotal = decisionCounts
    .slice(-ROLLING_WINDOW)
    .reduce((total, count) => total + count, 0);
  const capacities = [3, ROLLING_WINDOW, 12]
    .map((window) => rollingCapacity(decisionCounts, window))
    .filter((capacity) => capacity > 0);

  const queueAheadByMonth = [];
  let queue = 0;
  for (let index = 0; index < applicationCounts.length; index += 1) {
    queueAheadByMonth[index] = queue;
    queue = Math.max(0, queue + applicationCounts[index] - decisionCounts[index]);
  }

  const byMonth = {};
  for (const month of targetMonths) {
    const arrivals = applicationCounts[month.index];
    if (
      arrivals < SUPPRESSION_THRESHOLD ||
      recentDecisionTotal < SUPPRESSION_THRESHOLD ||
      capacities.length === 0
    ) {
      byMonth[month.period] = null;
      continue;
    }

    const variants = capacities
      .map((futureCapacity) => estimateCohort({
        cohortIndex: month.index,
        arrivals,
        decisions: decisionCounts,
        queueAhead: queueAheadByMonth[month.index],
        futureCapacity,
      }))
      .filter(Boolean);

    const central = estimateCohort({
      cohortIndex: month.index,
      arrivals,
      decisions: decisionCounts,
      queueAhead: queueAheadByMonth[month.index],
      futureCapacity: rollingCapacity(decisionCounts, ROLLING_WINDOW),
    });

    if (!central || variants.length === 0) {
      byMonth[month.period] = null;
      continue;
    }

    const variantMonths = variants.map((variant) => variant.months);
    const lower = Math.max(0, floorHalf(Math.min(...variantMonths) - 0.5));
    const upper = Math.max(lower + 0.5, ceilHalf(Math.max(...variantMonths) + 0.5));

    byMonth[month.period] = {
      months: round(central.months),
      lowerMonths: lower,
      upperMonths: upper,
      observedShare: round(central.observedShare),
      confidence: confidenceFor(arrivals, central.observedShare, recentDecisionTotal),
    };
  }

  return byMonth;
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
  const byMonth = buildEstimatesByMonth(
    applicationCounts,
    decisionCounts,
    targetMonthIndexes,
  );

  if (Object.values(byMonth).every((value) => value === null)) continue;

  const nationalityEstimates = {};
  const nationalityIds = new Set([
    ...application.nationalityCounts.keys(),
    ...(decision?.nationalityCounts.keys() ?? []),
  ]);
  for (const nationalityId of nationalityIds) {
    const nationalityApplications = application.nationalityCounts.get(nationalityId)
      ?? Array(monthIds.length).fill(0);
    const nationalityDecisions = decision?.nationalityCounts.get(nationalityId)
      ?? Array(monthIds.length).fill(0);
    const byNationalityMonth = buildEstimatesByMonth(
      nationalityApplications,
      nationalityDecisions,
      targetMonthIndexes,
    );
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
    model: "FIFO cohort queue with observed decisions and rolling-capacity projection",
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
