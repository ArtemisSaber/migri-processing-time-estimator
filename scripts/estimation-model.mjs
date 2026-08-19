const EPSILON = 1e-9;

export function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + Number(value || 0), 0) / values.length;
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function windowValues(values, endIndex, window) {
  const end = Math.min(values.length, endIndex + 1);
  const start = Math.max(0, end - window);
  return values.slice(start, end).map((value) => Number(value || 0));
}

function windowMean(values, endIndex, window) {
  return mean(windowValues(values, endIndex, window));
}

function windowSum(values, endIndex, window) {
  return sum(windowValues(values, endIndex, window));
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function growthRatio(values, endIndex, shortWindow, longWindow, bounds) {
  if (!values || values.length === 0) return null;
  const recent = windowMean(values, endIndex, shortWindow);
  const baseline = windowMean(values, endIndex, longWindow);
  if (baseline <= 0 && recent <= 0) return null;
  return clamp(
    (recent + 0.5) / (baseline + 0.5),
    bounds[0],
    bounds[1],
  );
}

function logResidualUncertainty(decisions, endIndex, options) {
  const residuals = [];
  const start = Math.max(
    options.shortWindowMonths,
    endIndex - options.volatilityWindowMonths + 1,
  );

  for (let index = start; index <= endIndex; index += 1) {
    const expected = windowMean(
      decisions,
      index - 1,
      options.shortWindowMonths,
    );
    if (expected <= 0 && Number(decisions[index] || 0) <= 0) continue;
    residuals.push(Math.log(
      (Number(decisions[index] || 0) + 0.5) / (expected + 0.5),
    ));
  }

  return standardDeviation(residuals);
}

/**
 * Empirical-Bayes dynamic capacity forecast.
 *
 * The path's recent decision rate is shrunk toward its longer-run rate after
 * applying the throughput movement visible in its closest sibling paths and
 * the rest of the dataset. Sparse paths therefore inherit the shared service
 * regime while high-volume paths remain driven by their own observations.
 */
export function forecastHierarchicalCapacity({
  decisions,
  relatedDecisions = [],
  globalDecisions = [],
  throughIndex = decisions.length - 1,
  options,
}) {
  const shortWindow = options.shortWindowMonths;
  const longWindow = options.longWindowMonths;
  const ownRecent = windowMean(decisions, throughIndex, shortWindow);
  const ownLong = windowMean(decisions, throughIndex, longWindow);
  const recentDecisionTotal = windowSum(decisions, throughIndex, shortWindow);
  const bounds = [
    options.sharedGrowthFloor,
    options.sharedGrowthCeiling,
  ];

  const relatedGrowth = growthRatio(
    relatedDecisions,
    throughIndex,
    shortWindow,
    longWindow,
    bounds,
  );
  const globalGrowth = growthRatio(
    globalDecisions,
    throughIndex,
    shortWindow,
    longWindow,
    bounds,
  );
  const growthSignals = [];
  if (relatedGrowth !== null) {
    growthSignals.push({
      ratio: relatedGrowth,
      weight: options.relatedCapacityWeight,
    });
  }
  if (globalGrowth !== null) {
    growthSignals.push({
      ratio: globalGrowth,
      weight: 1 - options.relatedCapacityWeight,
    });
  }

  const totalSignalWeight = sum(growthSignals.map((signal) => signal.weight));
  const sharedGrowth = totalSignalWeight > 0
    ? Math.exp(sum(growthSignals.map(
      (signal) => (signal.weight / totalSignalWeight) * Math.log(signal.ratio),
    )))
    : 1;
  const equilibrium = ownLong * sharedGrowth;
  const reliability = recentDecisionTotal <= 0
    ? 0
    : recentDecisionTotal
      / (recentDecisionTotal + options.capacityPriorDecisions);
  const central = reliability * ownRecent + (1 - reliability) * equilibrium;

  const processUncertainty = logResidualUncertainty(
    decisions,
    throughIndex,
    options,
  );
  const samplingUncertainty = 1 / Math.sqrt(recentDecisionTotal + 1);
  const uncertainty = clamp(
    Math.sqrt(
      (processUncertainty ** 2) / Math.max(1, shortWindow)
      + samplingUncertainty ** 2,
    ),
    options.minimumCapacityUncertainty,
    options.maximumCapacityUncertainty,
  );
  const lowerMultiplier = Math.exp(-options.capacityRangeZ * uncertainty);
  const upperMultiplier = Math.exp(options.capacityRangeZ * uncertainty);

  function valueAt(offset, variant = "central") {
    const horizon = Math.max(0, Number(offset));
    const meanReversion = options.capacityMeanReversion ** horizon;
    const projected = Math.max(
      0,
      equilibrium + (central - equilibrium) * meanReversion,
    );
    if (variant === "low") return projected * lowerMultiplier;
    if (variant === "high") return projected * upperMultiplier;
    return projected;
  }

  return {
    central,
    equilibrium,
    reliability,
    recentDecisionTotal,
    sharedGrowth,
    uncertainty,
    valueAt,
  };
}

/**
 * Allocates one forecast service-capacity pool across nationality classes.
 * Recent decision share is shrunk toward recent application share, then
 * gradually mean-reverts toward demand composition. Shares always sum to one;
 * the caller remains responsible for servicing each class's own inventory.
 */
export function forecastNationalityCapacityShares({
  applicationSeries,
  decisionSeries,
  throughIndex,
  options,
}) {
  const nationalityIds = [...new Set([
    ...applicationSeries.keys(),
    ...decisionSeries.keys(),
  ])].sort((left, right) => left.localeCompare(right, undefined, {
    numeric: true,
  }));
  const seriesLength = Math.max(
    0,
    ...[...applicationSeries.values(), ...decisionSeries.values()]
      .map((series) => series.length),
  );
  const endIndex = throughIndex === undefined
    ? seriesLength - 1
    : Number(throughIndex);
  if (nationalityIds.length === 0) {
    return {
      centralShares: new Map(),
      demandShares: new Map(),
      reliabilities: new Map(),
      shareAt: () => 0,
    };
  }

  const applicationVolumes = new Map(nationalityIds.map((id) => [
    id,
    windowSum(
      applicationSeries.get(id) ?? [],
      endIndex,
      options.longWindowMonths,
    ),
  ]));
  const decisionVolumes = new Map(nationalityIds.map((id) => [
    id,
    windowSum(
      decisionSeries.get(id) ?? [],
      endIndex,
      options.shortWindowMonths,
    ),
  ]));
  const applicationTotal = sum([...applicationVolumes.values()]);
  const decisionTotal = sum([...decisionVolumes.values()]);
  const demandShares = new Map();
  const serviceShares = new Map();
  const reliabilities = new Map();
  const rawCentralShares = new Map();

  for (const id of nationalityIds) {
    const applicationVolume = applicationVolumes.get(id) ?? 0;
    const decisionVolume = decisionVolumes.get(id) ?? 0;
    const demandShare = applicationTotal > 0
      ? applicationVolume / applicationTotal
      : decisionTotal > 0
        ? decisionVolume / decisionTotal
        : 1 / nationalityIds.length;
    const serviceShare = decisionTotal > 0
      ? decisionVolume / decisionTotal
      : demandShare;
    const reliability = decisionVolume
      / (decisionVolume + options.capacityPriorDecisions);
    const rawCentral = reliability * serviceShare
      + (1 - reliability) * demandShare;

    demandShares.set(id, demandShare);
    serviceShares.set(id, serviceShare);
    reliabilities.set(id, reliability);
    rawCentralShares.set(id, rawCentral);
  }

  const rawCentralTotal = sum([...rawCentralShares.values()]);
  const centralShares = new Map(nationalityIds.map((id) => [
    id,
    rawCentralTotal > 0
      ? rawCentralShares.get(id) / rawCentralTotal
      : demandShares.get(id),
  ]));

  return {
    centralShares,
    demandShares,
    serviceShares,
    reliabilities,
    shareAt(id, offset) {
      const persistence = options.capacityMeanReversion
        ** Math.max(0, Number(offset));
      const demandShare = demandShares.get(id) ?? 0;
      const centralShare = centralShares.get(id) ?? demandShare;
      return Math.max(
        0,
        demandShare + (centralShare - demandShare) * persistence,
      );
    },
  };
}

/**
 * Reconstructs opening inventory for a multi-class queue whose case identity
 * is preserved. Each nationality has its own stock equation; shared capacity
 * may influence future service rates but never moves cases between classes.
 *
 * Exact checkpoints fix the total opening stock, approximate checkpoints act
 * as soft calibration targets, and minimum checkpoints impose lower bounds.
 * Per-nationality floors come from the worst cumulative
 * applications-minus-decisions balance over the complete constraint horizon.
 * Stock above those floors follows the supplied opening-month weights.
 */
export function reconstructNationalityBacklogs({
  applicationSeries,
  decisionSeries,
  checkpoints,
  checkpointIndex,
  pendingApplications,
  seedWeights = new Map(),
  constraintsThroughIndex,
}) {
  const nationalityIds = [...new Set([
    ...applicationSeries.keys(),
    ...decisionSeries.keys(),
  ])].sort((left, right) => left.localeCompare(right, undefined, {
    numeric: true,
  }));
  const seriesLength = Math.max(
    0,
    ...[...applicationSeries.values(), ...decisionSeries.values()]
      .map((series) => series.length),
  );
  const normalizedCheckpoints = Array.isArray(checkpoints) && checkpoints.length > 0
    ? checkpoints.map((checkpoint) => ({
      index: Number(checkpoint.index),
      pendingApplications: Number(checkpoint.pendingApplications),
      relation: checkpoint.relation ?? "exact",
      weight: Math.max(EPSILON, Number(checkpoint.weight ?? 1)),
      label: checkpoint.label ?? "",
    }))
    : [{
      index: Number(checkpointIndex),
      pendingApplications: Number(pendingApplications),
      relation: "exact",
      weight: 1,
      label: "",
    }];
  const primaryCheckpoint = [...normalizedCheckpoints]
    .reverse()
    .find((checkpoint) => checkpoint.relation === "exact")
    ?? normalizedCheckpoints.at(-1);
  const latestCheckpointIndex = Math.max(
    0,
    ...normalizedCheckpoints.map((checkpoint) => checkpoint.index),
  );
  const constraintEnd = constraintsThroughIndex === undefined
    ? seriesLength
    : Number(constraintsThroughIndex);

  for (const checkpoint of normalizedCheckpoints) {
    if (
      !Number.isInteger(checkpoint.index)
      || checkpoint.index < 0
      || checkpoint.index > seriesLength
    ) {
      throw new Error("Backlog checkpoint index is outside the nationality series.");
    }
    if (
      !Number.isFinite(checkpoint.pendingApplications)
      || checkpoint.pendingApplications < 0
    ) {
      throw new Error("Backlog checkpoint pending applications must be non-negative.");
    }
    if (!["exact", "approximate", "minimum"].includes(checkpoint.relation)) {
      throw new Error(`Unsupported backlog checkpoint relation ${checkpoint.relation}.`);
    }
  }
  if (
    !Number.isInteger(constraintEnd)
    || constraintEnd < latestCheckpointIndex
    || constraintEnd > seriesLength
  ) {
    throw new Error("Backlog constraint horizon must include the checkpoint and remain inside the series.");
  }
  if (
    nationalityIds.length === 0
    && normalizedCheckpoints.some(
      (checkpoint) => checkpoint.pendingApplications > EPSILON,
    )
  ) {
    throw new Error("Cannot allocate a positive checkpoint without nationality series.");
  }

  const rows = nationalityIds.map((id) => {
    const applications = applicationSeries.get(id) ?? Array(seriesLength).fill(0);
    const decisions = decisionSeries.get(id) ?? Array(seriesLength).fill(0);
    let cumulativeNet = 0;
    let minimumCumulativeNet = 0;
    const checkpointNets = new Map(normalizedCheckpoints.map(
      (checkpoint) => [checkpoint.index, 0],
    ));

    for (let index = 0; index < constraintEnd; index += 1) {
      cumulativeNet += Number(applications[index] || 0)
        - Number(decisions[index] || 0);
      minimumCumulativeNet = Math.min(minimumCumulativeNet, cumulativeNet);
      if (checkpointNets.has(index + 1)) {
        checkpointNets.set(index + 1, cumulativeNet);
      }
    }

    return {
      id,
      applications,
      decisions,
      checkpointNets,
      minimumInitialBacklog: -minimumCumulativeNet,
      seedWeight: Math.max(0, Number(seedWeights.get(id) || 0)),
    };
  });
  const checkpointConstraints = normalizedCheckpoints.map((checkpoint) => {
    const checkpointNet = sum(rows.map(
      (row) => row.checkpointNets.get(checkpoint.index) ?? 0,
    ));
    return {
      ...checkpoint,
      checkpointNet,
      impliedInitialBacklog: checkpoint.pendingApplications - checkpointNet,
    };
  });
  const minimumRequiredInitialBacklog = sum(
    rows.map((row) => row.minimumInitialBacklog),
  );
  const exactConstraints = checkpointConstraints.filter(
    (checkpoint) => checkpoint.relation === "exact",
  );
  const approximateConstraints = checkpointConstraints.filter(
    (checkpoint) => checkpoint.relation === "approximate",
  );
  const checkpointMinimumInitialBacklog = Math.max(
    0,
    ...checkpointConstraints
      .filter((checkpoint) => checkpoint.relation === "minimum")
      .map((checkpoint) => checkpoint.impliedInitialBacklog),
  );
  let requiredInitialBacklog;

  if (exactConstraints.length > 0) {
    requiredInitialBacklog = exactConstraints[0].impliedInitialBacklog;
    for (const checkpoint of exactConstraints.slice(1)) {
      if (
        Math.abs(checkpoint.impliedInitialBacklog - requiredInitialBacklog)
        > 1e-6
      ) {
        throw new Error("Exact backlog checkpoints imply inconsistent opening stocks.");
      }
    }
  } else if (approximateConstraints.length > 0) {
    const totalWeight = sum(approximateConstraints.map(
      (checkpoint) => checkpoint.weight,
    ));
    requiredInitialBacklog = sum(approximateConstraints.map(
      (checkpoint) => checkpoint.impliedInitialBacklog * checkpoint.weight,
    )) / totalWeight;
  } else {
    requiredInitialBacklog = Math.max(
      minimumRequiredInitialBacklog,
      checkpointMinimumInitialBacklog,
    );
  }
  const hardMinimumInitialBacklog = Math.max(
    minimumRequiredInitialBacklog,
    checkpointMinimumInitialBacklog,
  );
  if (exactConstraints.length === 0) {
    requiredInitialBacklog = Math.max(
      requiredInitialBacklog,
      hardMinimumInitialBacklog,
    );
  }

  if (requiredInitialBacklog < -EPSILON) {
    throw new Error(
      `Checkpoint implies a negative opening backlog (${requiredInitialBacklog}).`,
    );
  }
  if (hardMinimumInitialBacklog > requiredInitialBacklog + EPSILON) {
    throw new Error(
      `Nationality-preserving constraints require ${hardMinimumInitialBacklog} opening cases, but the checkpoint permits only ${requiredInitialBacklog}.`,
    );
  }

  const initialBacklogs = new Map(rows.map((row) => [
    row.id,
    row.minimumInitialBacklog,
  ]));
  const slack = Math.max(
    0,
    requiredInitialBacklog - minimumRequiredInitialBacklog,
  );
  let active = rows.filter((row) => row.seedWeight > EPSILON);
  const fixed = new Set(rows
    .filter((row) => row.seedWeight <= EPSILON)
    .map((row) => row.id));

  while (active.length > 0) {
    const fixedTotal = rows
      .filter((row) => fixed.has(row.id))
      .reduce((total, row) => total + row.minimumInitialBacklog, 0);
    const activeWeight = sum(active.map((row) => row.seedWeight));
    const scale = activeWeight > 0
      ? (requiredInitialBacklog - fixedTotal) / activeWeight
      : 0;
    const newlyFixed = active.filter(
      (row) => scale * row.seedWeight < row.minimumInitialBacklog - EPSILON,
    );

    if (newlyFixed.length === 0) {
      for (const row of active) {
        initialBacklogs.set(row.id, scale * row.seedWeight);
      }
      break;
    }
    for (const row of newlyFixed) fixed.add(row.id);
    active = active.filter((row) => !fixed.has(row.id));
  }

  if (active.length === 0 && slack > EPSILON) {
    const recipients = rows.length > 0 ? rows : [];
    for (const row of recipients) {
      initialBacklogs.set(
        row.id,
        initialBacklogs.get(row.id) + slack / recipients.length,
      );
    }
  }

  const minimumBacklogs = new Map();
  const checkpointBacklogs = new Map();
  let reconstructedCheckpoint = 0;
  let minimumBacklog = Infinity;

  for (const row of rows) {
    const initialBacklog = initialBacklogs.get(row.id) ?? 0;
    let backlog = initialBacklog;
    let nationalityMinimum = backlog;
    let checkpointBacklog = primaryCheckpoint.index === 0 ? backlog : null;

    for (let index = 0; index < constraintEnd; index += 1) {
      backlog += Number(row.applications[index] || 0)
        - Number(row.decisions[index] || 0);
      nationalityMinimum = Math.min(nationalityMinimum, backlog);
      if (index + 1 === primaryCheckpoint.index) checkpointBacklog = backlog;
    }
    minimumBacklogs.set(row.id, nationalityMinimum);
    checkpointBacklogs.set(row.id, checkpointBacklog ?? initialBacklog);
    reconstructedCheckpoint += checkpointBacklog ?? initialBacklog;
    minimumBacklog = Math.min(minimumBacklog, nationalityMinimum);
  }

  if (minimumBacklog < -EPSILON) {
    throw new Error(`Nationality backlog constraint violated by ${minimumBacklog}.`);
  }
  const checkpointResults = checkpointConstraints.map((checkpoint) => {
    const reconstructed = requiredInitialBacklog + checkpoint.checkpointNet;
    const residual = reconstructed - checkpoint.pendingApplications;
    const satisfied = checkpoint.relation === "exact"
      ? Math.abs(residual) <= 1e-6
      : checkpoint.relation === "minimum"
        ? residual >= -1e-6
        : null;
    if (satisfied === false) {
      throw new Error(
        `Backlog checkpoint ${checkpoint.label || checkpoint.index} is not satisfied.`,
      );
    }
    return {
      index: checkpoint.index,
      label: checkpoint.label,
      relation: checkpoint.relation,
      pendingApplications: checkpoint.pendingApplications,
      checkpointNet: checkpoint.checkpointNet,
      impliedInitialBacklog: checkpoint.impliedInitialBacklog,
      reconstructed,
      residual,
      relativeResidual: checkpoint.pendingApplications > 0
        ? residual / checkpoint.pendingApplications
        : 0,
      satisfied,
    };
  });
  const primaryResult = checkpointResults.find((checkpoint) => (
    checkpoint.index === primaryCheckpoint.index
    && checkpoint.relation === primaryCheckpoint.relation
  ));
  if (
    primaryCheckpoint.relation === "exact"
    && Math.abs(
      reconstructedCheckpoint - primaryCheckpoint.pendingApplications,
    ) > 1e-6
  ) {
    throw new Error("Primary exact backlog checkpoint is not satisfied.");
  }

  return {
    initialBacklogs,
    minimumInitialBacklogs: new Map(rows.map((row) => [
      row.id,
      row.minimumInitialBacklog,
    ])),
    checkpointBacklogs,
    minimumBacklogs,
    requiredInitialBacklog,
    minimumRequiredInitialBacklog,
    discretionaryInitialBacklog: slack,
    checkpointMinimumInitialBacklog,
    hardMinimumInitialBacklog,
    checkpointNet: primaryResult?.checkpointNet ?? 0,
    reconstructedCheckpoint,
    checkpointResults,
    minimumBacklog: minimumBacklog === Infinity ? 0 : minimumBacklog,
    bindingNationalityCount: rows.filter((row) => (
      Math.abs(
        (initialBacklogs.get(row.id) ?? 0) - row.minimumInitialBacklog,
      ) <= 1e-6
    )).length,
  };
}

function allocateToCohort(cohort, amount, monthIndex, observedMonthCount) {
  const allocation = Math.min(cohort.remaining, Math.max(0, amount));
  if (allocation <= EPSILON) return 0;
  cohort.remaining -= allocation;
  if (cohort.tracked) {
    cohort.processed += allocation;
    cohort.weightedWait += allocation * Math.max(0, monthIndex - cohort.index);
    if (monthIndex < observedMonthCount) cohort.observedProcessed += allocation;
  }
  return allocation;
}

function allocateOldestFirst(activeCohorts, capacity, monthIndex, observedMonthCount) {
  let remainingCapacity = Math.max(0, capacity);
  for (const cohort of activeCohorts) {
    if (remainingCapacity <= EPSILON) break;
    remainingCapacity -= allocateToCohort(
      cohort,
      remainingCapacity,
      monthIndex,
      observedMonthCount,
    );
  }
  return capacity - remainingCapacity;
}

function allocateByAge(activeCohorts, capacity, monthIndex, observedMonthCount, agePower) {
  let remainingCapacity = Math.max(0, capacity);
  let eligible = activeCohorts.filter((cohort) => cohort.remaining > EPSILON);

  while (remainingCapacity > EPSILON && eligible.length > 0) {
    const roundCapacity = remainingCapacity;
    const weighted = eligible.map((cohort) => ({
      cohort,
      weight: Math.max(1, monthIndex - cohort.index + 1) ** agePower,
    }));
    const weightTotal = sum(weighted.map((item) => item.weight));
    let allocated = 0;

    for (const item of weighted) {
      allocated += allocateToCohort(
        item.cohort,
        roundCapacity * item.weight / weightTotal,
        monthIndex,
        observedMonthCount,
      );
    }

    if (allocated <= EPSILON) break;
    remainingCapacity -= allocated;
    eligible = eligible.filter((cohort) => cohort.remaining > EPSILON);
  }

  return capacity - remainingCapacity;
}

/**
 * Deterministic cohort-flow simulation. Most capacity clears the oldest
 * cohorts first; the remaining share is distributed with an age-weighted
 * hazard so later cohorts can progress without claiming strict real-world FIFO.
 */
export function simulateSoftFifoCohorts({
  applications,
  observedCapacity,
  initialBacklog = 0,
  targetIndexes,
  futureCapacityAt,
  futureApplicationsAt,
  maxProjectionMonths,
  fifoPriorityShare,
  softFifoAgePower,
}) {
  const observedMonthCount = applications.length;
  const trackedIndexes = new Set(targetIndexes);
  const trackedCohorts = new Map();
  const seededBacklog = Math.max(0, Number(initialBacklog || 0));
  let activeCohorts = seededBacklog > EPSILON
    ? [{
      index: -1,
      original: seededBacklog,
      remaining: seededBacklog,
      tracked: false,
      processed: 0,
      observedProcessed: 0,
      weightedWait: 0,
    }]
    : [];

  for (
    let monthIndex = 0;
    monthIndex < observedMonthCount + maxProjectionMonths;
    monthIndex += 1
  ) {
    const isObservedMonth = monthIndex < observedMonthCount;
    const futureOffset = monthIndex - observedMonthCount;
    const arrivals = Math.max(
      0,
      isObservedMonth
        ? Number(applications[monthIndex] || 0)
        : Number(futureApplicationsAt(futureOffset) || 0),
    );
    if (arrivals > EPSILON) {
      const cohort = {
        index: monthIndex,
        original: arrivals,
        remaining: arrivals,
        tracked: isObservedMonth && trackedIndexes.has(monthIndex),
        processed: 0,
        observedProcessed: 0,
        weightedWait: 0,
      };
      activeCohorts.push(cohort);
      if (cohort.tracked) trackedCohorts.set(monthIndex, cohort);
    }

    const capacity = Math.max(
      0,
      isObservedMonth
        ? Number(observedCapacity[monthIndex] || 0)
        : Number(futureCapacityAt(futureOffset) || 0),
    );
    const fifoBudget = capacity * fifoPriorityShare;
    const fifoAllocated = allocateOldestFirst(
      activeCohorts,
      fifoBudget,
      monthIndex,
      observedMonthCount,
    );
    let flexibleBudget = capacity - fifoAllocated;
    const flexibleAllocated = allocateByAge(
      activeCohorts,
      flexibleBudget,
      monthIndex,
      observedMonthCount,
      softFifoAgePower,
    );
    flexibleBudget -= flexibleAllocated;
    if (flexibleBudget > EPSILON) {
      allocateOldestFirst(
        activeCohorts,
        flexibleBudget,
        monthIndex,
        observedMonthCount,
      );
    }

    activeCohorts = activeCohorts.filter((cohort) => cohort.remaining > EPSILON);
    const allTrackedComplete = trackedCohorts.size === trackedIndexes.size
      && [...trackedCohorts.values()].every(
        (cohort) => cohort.remaining <= EPSILON,
      );
    if (monthIndex >= observedMonthCount - 1 && allTrackedComplete) break;
  }

  return new Map([...trackedCohorts].map(([index, cohort]) => [index, (
    cohort.processed >= cohort.original - EPSILON
      ? {
        months: cohort.weightedWait / cohort.original,
        observedShare: Math.min(1, cohort.observedProcessed / cohort.original),
      }
      : null
  )]));
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

function confidenceFor(arrivals, observedShare, recentDecisions, reliability) {
  if (
    arrivals >= 30
    && observedShare >= 0.8
    && recentDecisions >= 30
    && reliability >= 0.5
  ) return "high";
  if (arrivals >= 12 && recentDecisions >= 18 && reliability >= 0.2) {
    return "medium";
  }
  return "low";
}

export function buildCohortEstimates({
  applications,
  observedCapacity,
  initialBacklog = 0,
  targetMonths,
  capacityForecast,
  applicationForecast,
  recentWindowMonths,
  suppressionThreshold,
  maxProjectionMonths,
  fifoPriorityShare,
  softFifoAgePower,
  reliability = 1,
}) {
  const targetIndexes = targetMonths.map((month) => month.index);
  const simulations = Object.fromEntries(
    ["central", "low", "high"].map((variant) => [variant, (
      simulateSoftFifoCohorts({
        applications,
        observedCapacity,
        initialBacklog,
        targetIndexes,
        futureCapacityAt: (offset) => capacityForecast(offset, variant),
        futureApplicationsAt: (offset) => applicationForecast(offset),
        maxProjectionMonths,
        fifoPriorityShare,
        softFifoAgePower,
      })
    )]),
  );
  const recentDecisionTotal = sum(observedCapacity.slice(-recentWindowMonths));
  const byMonth = {};

  for (const month of targetMonths) {
    const arrivals = Number(applications[month.index] || 0);
    const central = simulations.central.get(month.index);
    const variants = [
      simulations.central.get(month.index),
      simulations.low.get(month.index),
      simulations.high.get(month.index),
    ].filter(Boolean);

    if (
      arrivals < suppressionThreshold
      || recentDecisionTotal < suppressionThreshold
      || !central
      || variants.length === 0
    ) {
      byMonth[month.period] = null;
      continue;
    }

    const variantMonths = variants.map((variant) => variant.months);
    const lower = Math.max(0, floorHalf(Math.min(...variantMonths) - 0.5));
    const upper = Math.max(
      lower + 0.5,
      ceilHalf(Math.max(...variantMonths) + 0.5),
    );
    byMonth[month.period] = {
      months: round(central.months),
      lowerMonths: lower,
      upperMonths: upper,
      observedShare: round(central.observedShare),
      confidence: confidenceFor(
        arrivals,
        central.observedShare,
        recentDecisionTotal,
        reliability,
      ),
    };
  }

  return byMonth;
}
