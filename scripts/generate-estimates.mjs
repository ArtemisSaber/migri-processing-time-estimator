import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  buildCohortEstimates,
  forecastHierarchicalCapacity,
  forecastNationalityCapacityShares,
  reconstructNationalityBacklogs,
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
const externalAnchorsPath = resolve(process.cwd(), config.externalAnchorsFile);
const externalAnchorCatalog = JSON.parse(
  readFileSync(externalAnchorsPath, "utf8"),
);
const sourceBuffer = readFileSync(sourcePath);
const sourceText = sourceBuffer[0] === 0x1f && sourceBuffer[1] === 0x8b
  ? gunzipSync(sourceBuffer).toString("utf8")
  : sourceBuffer.toString("utf8");
const source = JSON.parse(sourceText);
const HISTORY_MONTHS = Number(config.historyMonths);
const ROLLING_WINDOW = Number(config.rollingWindowMonths);
const SUPPRESSION_THRESHOLD = Number(config.suppressionThreshold);
const MAX_PROJECTION_MONTHS = Number(config.maxProjectionMonths);
const UNCLASSIFIED_NATIONALITY_ID = "__unclassified__";
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

function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function anchorMatchesSelector(anchor, selector) {
  return Object.entries(selector ?? {}).every(([key, value]) => (
    anchor?.[key] === value
  ));
}

function normalizeExternalAnchor(anchor) {
  const period = typeof anchor?.date === "string"
    ? anchor.date.slice(0, 7)
    : "";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    throw new Error(`Invalid external anchor date ${anchor?.date ?? "(missing)"}.`);
  }

  let relation;
  let value;
  if (anchor.qualifier === "more_than") {
    relation = "minimum";
    value = anchor.min_value;
  } else if (anchor.qualifier === "slightly_over") {
    relation = "minimum";
    value = anchor.min_value ?? anchor.value;
  } else if (anchor.qualifier === "fewer_than") {
    relation = "maximum";
    value = anchor.max_value;
  } else if (anchor.qualifier === "approximately") {
    relation = "approximate";
    value = anchor.value;
  } else if (anchor.qualifier === "exact_as_published") {
    relation = "exact";
    value = anchor.value;
  } else {
    relation = "exact";
    value = anchor.value;
  }

  if (!Number.isFinite(Number(value)) || Number(value) < 0) {
    throw new Error(`External anchor ${anchor.date} has no valid queue value.`);
  }

  return {
    date: anchor.date,
    period,
    metric: anchor.metric,
    nationality: anchor.nationality ?? null,
    relation,
    value: Number(value),
    qualifier: anchor.qualifier ?? "",
    source: anchor.source_url ?? "",
    note: anchor.note ?? "",
  };
}

function buildExternalAnchorRegistry(catalog, mappings) {
  if (!Array.isArray(catalog?.anchors)) {
    throw new Error("The external anchor catalog must contain an anchors array.");
  }
  const mappingIds = new Set();
  const registry = new Map();

  for (const mapping of mappings ?? []) {
    if (typeof mapping?.id !== "string" || mapping.id.length === 0) {
      throw new Error("Every external anchor mapping must have an ID.");
    }
    if (mappingIds.has(mapping.id)) {
      throw new Error(`Duplicate external anchor mapping ID ${mapping.id}.`);
    }
    if (!["calibration", "diagnostic", "deferred", "excluded"].includes(
      mapping.disposition,
    )) {
      throw new Error(`Unsupported external anchor disposition ${mapping.disposition}.`);
    }
    mappingIds.add(mapping.id);
    registry.set(mapping.id, { mapping, anchors: [] });
  }

  for (const rawAnchor of catalog.anchors) {
    const matches = [...registry.values()].filter(({ mapping }) => (
      anchorMatchesSelector(rawAnchor, mapping.selector)
    ));
    if (matches.length !== 1) {
      throw new Error(
        `External anchor ${rawAnchor.date ?? "(undated)"} / ${rawAnchor.category ?? "(uncategorized)"} matched ${matches.length} mappings.`,
      );
    }
    matches[0].anchors.push(normalizeExternalAnchor(rawAnchor));
  }

  for (const [id, entry] of registry) {
    if (entry.anchors.length === 0) {
      throw new Error(`External anchor mapping ${id} matched no anchors.`);
    }
  }

  return registry;
}

function summarizeExternalAnchors({
  catalog,
  registry,
  sourceThrough,
}) {
  const dispositions = {};
  const mappings = [...registry.entries()].map(([id, { mapping, anchors }]) => {
    const summarizedAnchors = anchors.map((anchor) => {
      const withinSource = anchor.period <= sourceThrough;
      const disposition = mapping.disposition === "excluded"
        ? "excluded"
        : withinSource
          ? mapping.disposition
          : "deferred";
      dispositions[disposition] = (dispositions[disposition] ?? 0) + 1;
      return {
        date: anchor.date,
        period: anchor.period,
        metric: anchor.metric,
        nationality: anchor.nationality,
        relation: anchor.relation,
        value: anchor.value,
        qualifier: anchor.qualifier,
        disposition,
        withinSource,
        source: anchor.source,
      };
    });
    return {
      id,
      disposition: mapping.disposition,
      scopePrefixes: mapping.scopePrefixes,
      reason: mapping.reason,
      anchors: summarizedAnchors,
    };
  });

  return {
    sourceFile: basename(externalAnchorsPath),
    generatedAt: catalog.generated_at ?? "",
    description: catalog.description ?? "",
    totalAnchors: catalog.anchors.length,
    dispositions,
    mappings,
  };
}

function pathMatchesScope(path, scopePrefixes) {
  return scopePrefixes.some((prefix) => (
    path === prefix || path.startsWith(`${prefix}/`)
  ));
}

function nationalityCountAt(series, nationalityId, index) {
  if (nationalityId !== UNCLASSIFIED_NATIONALITY_ID) {
    return Number(series?.nationalityCounts.get(nationalityId)?.[index] || 0);
  }
  const classified = sum([...series.nationalityCounts.values()].map(
    (counts) => Number(counts[index] || 0),
  ));
  const unclassified = Number(series.counts[index] || 0) - classified;
  if (unclassified < -1e-6) {
    throw new Error("Nationality counts exceed their application-type total.");
  }
  return Math.max(0, unclassified);
}

function buildPathNationalitySeries(series, length) {
  const result = new Map();
  if (!series) return result;

  for (const [nationalityId, counts] of series.nationalityCounts) {
    result.set(nationalityId, [...counts]);
  }
  const unclassified = Array.from({ length }, (_, index) => (
    nationalityCountAt(series, UNCLASSIFIED_NATIONALITY_ID, index)
  ));
  if (sum(unclassified) > 0) {
    result.set(UNCLASSIFIED_NATIONALITY_ID, unclassified);
  }

  return result;
}

function buildScopeNationalitySeries(seriesByPath, eligiblePaths, length) {
  const result = new Map();

  for (const path of eligiblePaths) {
    const pathSeries = buildPathNationalitySeries(
      seriesByPath.get(path),
      length,
    );
    for (const [nationalityId, counts] of pathSeries) {
      if (!result.has(nationalityId)) {
        result.set(nationalityId, Array(length).fill(0));
      }
      addSeries(result.get(nationalityId), counts);
    }
  }

  return result;
}

function buildInitialBacklogSeeds({
  calibrations,
  anchorRegistry,
  applicationsByPath,
  decisionsByPath,
  months,
}) {
  const seeds = new Map();
  const nationalitySeedsByPath = new Map();
  const claimedPaths = new Set();
  const metadata = [];

  for (const calibration of calibrations ?? []) {
    const scopePrefixes = Array.isArray(calibration.scopePrefixes)
      ? calibration.scopePrefixes.filter((value) => typeof value === "string")
      : [];
    if (scopePrefixes.length === 0) {
      throw new Error(`Backlog calibration ${calibration.name ?? "(unnamed)"} has no scope prefixes.`);
    }
    if (calibration.snapshotTiming !== "start-of-month") {
      throw new Error("Only start-of-month backlog checkpoints are supported.");
    }
    if (
      calibration.distribution
      !== "constrained-nationality-first-observed-month-application-share"
    ) {
      throw new Error("Unsupported initial backlog distribution method.");
    }

    const seedIndex = months.findIndex(
      ({ period }) => period === calibration.seedPeriod,
    );
    if (seedIndex !== 0) {
      throw new Error(
        "The configured initial backlog seed must match the first source month.",
      );
    }

    const anchorEntry = calibration.anchorMappingId
      ? anchorRegistry.get(calibration.anchorMappingId)
      : null;
    if (calibration.anchorMappingId && !anchorEntry) {
      throw new Error(
        `Unknown external anchor mapping ${calibration.anchorMappingId}.`,
      );
    }
    if (anchorEntry?.mapping.disposition !== "calibration") {
      throw new Error(
        `External anchor mapping ${calibration.anchorMappingId} is not approved for calibration.`,
      );
    }
    const configuredCheckpoints = anchorEntry
      ? anchorEntry.anchors.map((anchor) => ({
        period: anchor.period,
        pendingApplications: anchor.value,
        relation: anchor.relation,
        source: anchor.source,
        date: anchor.date,
        qualifier: anchor.qualifier,
      }))
      : Array.isArray(calibration.checkpoints)
        ? calibration.checkpoints
        : [];
    if (configuredCheckpoints.length === 0) {
      throw new Error(`Backlog calibration ${calibration.name ?? "(unnamed)"} has no checkpoints.`);
    }
    const checkpoints = configuredCheckpoints.map((checkpoint) => {
      const index = months.findIndex(
        ({ period }) => period === checkpoint.period,
      );
      if (index < 0) {
        throw new Error(
          `Backlog checkpoint ${checkpoint.period} is outside the source months.`,
        );
      }
      return {
        index,
        pendingApplications: checkpoint.pendingApplications,
        relation: checkpoint.relation,
        weight: checkpoint.weight,
        label: checkpoint.period,
        source: checkpoint.source ?? "",
        date: checkpoint.date ?? null,
        qualifier: checkpoint.qualifier ?? "",
      };
    });

    const eligiblePaths = [...applicationsByPath.keys()]
      .filter((path) => pathMatchesScope(path, scopePrefixes))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    if (eligiblePaths.length === 0) {
      throw new Error(`Backlog calibration ${calibration.name ?? "(unnamed)"} matches no paths.`);
    }
    for (const path of eligiblePaths) {
      if (claimedPaths.has(path)) {
        throw new Error(`Backlog calibration scopes overlap at ${path}.`);
      }
      claimedPaths.add(path);
    }

    const distributionApplicationCount = sum(eligiblePaths.map((path) => (
      Number(applicationsByPath.get(path)?.counts[seedIndex] || 0)
    )));
    if (distributionApplicationCount <= 0) {
      throw new Error("Cannot distribute initial backlog without first-month applications.");
    }

    const scopeApplications = buildScopeNationalitySeries(
      applicationsByPath,
      eligiblePaths,
      months.length,
    );
    const scopeDecisions = buildScopeNationalitySeries(
      decisionsByPath,
      eligiblePaths,
      months.length,
    );
    const nationalityIds = [...new Set([
      ...scopeApplications.keys(),
      ...scopeDecisions.keys(),
    ])];
    const seedWeights = new Map(nationalityIds.map((nationalityId) => [
      nationalityId,
      Number(scopeApplications.get(nationalityId)?.[seedIndex] || 0),
    ]));
    const reconstruction = reconstructNationalityBacklogs({
      applicationSeries: scopeApplications,
      decisionSeries: scopeDecisions,
      checkpoints,
      seedWeights,
      constraintsThroughIndex: months.length,
    });

    for (const [nationalityId, nationalitySeed] of reconstruction.initialBacklogs) {
      if (nationalitySeed <= 0) continue;
      let pathWeights = new Map(eligiblePaths.map((path) => [
        path,
        nationalityCountAt(
          applicationsByPath.get(path),
          nationalityId,
          seedIndex,
        ),
      ]));
      let pathWeightTotal = sum([...pathWeights.values()]);
      if (pathWeightTotal <= 0) {
        pathWeights = new Map(eligiblePaths.map((path) => [
          path,
          Number(applicationsByPath.get(path)?.counts[seedIndex] || 0),
        ]));
        pathWeightTotal = sum([...pathWeights.values()]);
      }
      if (pathWeightTotal <= 0) {
        throw new Error(`Cannot allocate the opening backlog for nationality ${nationalityId}.`);
      }

      for (const path of eligiblePaths) {
        const allocated = nationalitySeed
          * Number(pathWeights.get(path) || 0)
          / pathWeightTotal;
        seeds.set(path, (seeds.get(path) ?? 0) + allocated);
        if (!nationalitySeedsByPath.has(path)) {
          nationalitySeedsByPath.set(path, new Map());
        }
        nationalitySeedsByPath.get(path).set(nationalityId, allocated);
      }
    }

    const checkpointResults = reconstruction.checkpointResults.map((result) => {
      const configured = checkpoints.find((checkpoint) => (
        checkpoint.index === result.index
        && checkpoint.relation === result.relation
      ));
      return {
        period: result.label,
        relation: result.relation,
        pendingApplications: result.pendingApplications,
        netFlowFromSeed: round(result.checkpointNet),
        impliedInitialBacklog: round(result.impliedInitialBacklog),
        reconstructedBacklog: round(result.reconstructed),
        residual: round(result.residual),
        relativeResidual: round(result.relativeResidual, 4),
        satisfied: result.satisfied,
        source: configured?.source ?? "",
        date: configured?.date ?? null,
        qualifier: configured?.qualifier ?? "",
      };
    });
    const primaryCheckpoint = [...checkpointResults]
      .reverse()
      .find((checkpoint) => checkpoint.relation === "exact")
      ?? checkpointResults.at(-1);
    metadata.push({
      name: calibration.name ?? "Backlog calibration",
      source: primaryCheckpoint?.source ?? "",
      anchorMappingId: calibration.anchorMappingId ?? null,
      scopePrefixes,
      seedPeriod: calibration.seedPeriod,
      checkpointPeriod: primaryCheckpoint.period,
      snapshotTiming: calibration.snapshotTiming,
      pendingApplications: primaryCheckpoint.pendingApplications,
      distribution: calibration.distribution,
      checkpoints: checkpointResults,
      distributionApplicationCount,
      estimatedInitialBacklog: round(reconstruction.requiredInitialBacklog),
      minimumRequiredInitialBacklog: round(
        reconstruction.minimumRequiredInitialBacklog,
      ),
      discretionaryInitialBacklog: round(
        reconstruction.discretionaryInitialBacklog,
      ),
      netFlowAtCheckpoint: primaryCheckpoint.netFlowFromSeed,
      reconstructedAtCheckpoint: primaryCheckpoint.reconstructedBacklog,
      checkpointResidual: primaryCheckpoint.residual,
      constrainedThroughPeriod: months.at(-1).period,
      minimumQueueBalance: round(reconstruction.minimumBacklog, 6),
      constrainedNationalityCount: nationalityIds.length,
      bindingNationalityCount: reconstruction.bindingNationalityCount,
      allocatedPathCount: eligiblePaths.length,
    });
  }

  return { seeds, nationalitySeedsByPath, metadata };
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
const externalAnchorRegistry = buildExternalAnchorRegistry(
  externalAnchorCatalog,
  config.externalAnchorMappings,
);
const initialBacklog = buildInitialBacklogSeeds({
  calibrations: config.backlogCalibrations,
  anchorRegistry: externalAnchorRegistry,
  applicationsByPath,
  decisionsByPath,
  months,
});

const estimates = [];
const includedNationalityIds = new Set();

for (const path of paths) {
  const application = applicationsByPath.get(path);
  const decision = decisionsByPath.get(path);
  if (!application) continue;

  const applicationCounts = application.counts;
  const decisionCounts = decision?.counts ?? Array(monthIds.length).fill(0);
  const pathInitialBacklog = initialBacklog.seeds.get(path) ?? 0;
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
  const pathNationalityApplications = buildPathNationalitySeries(
    application,
    monthIds.length,
  );
  const pathNationalityDecisions = buildPathNationalitySeries(
    decision,
    monthIds.length,
  );
  const nationalityCapacityShares = forecastNationalityCapacityShares({
    applicationSeries: pathNationalityApplications,
    decisionSeries: pathNationalityDecisions,
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
    initialBacklog: pathInitialBacklog,
    capacityForecast: (offset, variant) => capacityModel.valueAt(offset, variant),
    applicationForecast: (offset) => applicationModel.valueAt(offset),
    reliability: capacityModel.reliability,
    ...commonEstimateOptions,
  });

  if (Object.values(byMonth).every((value) => value === null)) continue;

  const nationalityEstimates = {};
  const nationalityIds = [...new Set([
    ...application.nationalityCounts.keys(),
    ...(decision?.nationalityCounts.keys() ?? []),
  ])].sort((left, right) => left.localeCompare(right, undefined, {
    numeric: true,
  }));
  const nationalityPathSeeds = initialBacklog.nationalitySeedsByPath.get(path)
    ?? new Map();

  for (const nationalityId of nationalityIds) {
    const nationalityApplications = pathNationalityApplications.get(nationalityId)
      ?? Array(monthIds.length).fill(0);
    const nationalityDecisions = pathNationalityDecisions.get(nationalityId)
      ?? Array(monthIds.length).fill(0);
    const hasEstimableCohort = targetMonthIndexes.some(({ index }) => (
      Number(nationalityApplications[index] || 0) >= SUPPRESSION_THRESHOLD
    ));
    const recentNationalityDecisions = sum(
      nationalityDecisions.slice(-ROLLING_WINDOW),
    );
    if (!hasEstimableCohort || recentNationalityDecisions < SUPPRESSION_THRESHOLD) {
      continue;
    }

    const nationalityApplicationModel = forecastHierarchicalCapacity({
      decisions: nationalityApplications,
      relatedDecisions: subtractSeries(applicationCounts, nationalityApplications),
      globalDecisions: subtractSeries(globalApplicationCounts, applicationCounts),
      options: MODEL_OPTIONS,
    });
    const byNationalityMonth = buildCohortEstimates({
      applications: nationalityApplications,
      observedCapacity: nationalityDecisions,
      initialBacklog: nationalityPathSeeds.get(nationalityId) ?? 0,
      capacityForecast: (offset, variant) => (
        capacityModel.valueAt(offset, variant)
        * nationalityCapacityShares.shareAt(nationalityId, offset)
      ),
      applicationForecast: (offset) => (
        nationalityApplicationModel.valueAt(offset)
      ),
      reliability: nationalityCapacityShares.reliabilities.get(nationalityId)
        ?? 0,
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
    initialBacklog: round(pathInitialBacklog),
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
    model: "Nationality-preserving hierarchical shared-capacity soft-FIFO cohort model",
    modelVersion: 5,
    capacityModel: "One hierarchical application-type capacity forecast allocated across citizenship-preserving queues",
    initialBacklogModel: "Published-checkpoint nationality stock reconstruction with non-negative monthly balances",
    backlogCalibrations: initialBacklog.metadata,
    externalBacklogAnchors: summarizeExternalAnchors({
      catalog: externalAnchorCatalog,
      registry: externalAnchorRegistry,
      sourceThrough: months.at(-1).period,
    }),
    nationalityModel: "Nationality-preserving inventory; decisions never consume another citizenship's applications or backlog",
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
