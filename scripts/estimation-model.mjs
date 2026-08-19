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

function cumulativeSeries(values) {
  const result = [];
  let total = 0;
  for (const value of values) {
    total += Number(value || 0);
    result.push(total);
  }
  return result;
}

function cumulativeWindowTotal(cumulative, endIndex, window) {
  if (endIndex < 0 || cumulative.length === 0) return 0;
  const endTotal = cumulative[Math.min(endIndex, cumulative.length - 1)] ?? 0;
  const beforeIndex = endIndex - window;
  const beforeTotal = beforeIndex >= 0 ? cumulative[beforeIndex] : 0;
  return endTotal - beforeTotal;
}

/**
 * Builds nationality service series whose monthly values always sum to the
 * category's observed decisions. Allocation shares are learned from each
 * nationality's recent decision share relative to its demand share, then
 * shrunk toward demand-proportional allocation when evidence is sparse.
 */
export function buildPooledNationalityServices({
  applicationSeries,
  decisionSeries,
  totalApplications,
  totalDecisions,
  options,
}) {
  const nationalityIds = [...new Set([
    ...applicationSeries.keys(),
    ...decisionSeries.keys(),
  ])].sort((left, right) => left.localeCompare(right, undefined, {
    numeric: true,
  }));
  const length = totalApplications.length;
  const totalApplicationCumulative = cumulativeSeries(totalApplications);
  const totalDecisionCumulative = cumulativeSeries(totalDecisions);
  const applicationCumulative = new Map(nationalityIds.map((id) => [
    id,
    cumulativeSeries(applicationSeries.get(id) ?? Array(length).fill(0)),
  ]));
  const decisionCumulative = new Map(nationalityIds.map((id) => [
    id,
    cumulativeSeries(decisionSeries.get(id) ?? Array(length).fill(0)),
  ]));
  const services = new Map(nationalityIds.map((id) => [id, {
    counts: Array(length).fill(0),
    shares: Array(length).fill(0),
    demandShares: Array(length).fill(0),
    reliabilities: Array(length).fill(0),
  }]));

  for (let index = 0; index < length; index += 1) {
    const recentTotalApplications = cumulativeWindowTotal(
      totalApplicationCumulative,
      index,
      options.nationalityDemandWindowMonths,
    );
    const recentTotalDecisions = cumulativeWindowTotal(
      totalDecisionCumulative,
      index,
      options.shortWindowMonths,
    );
    const cumulativeTotalApplications = totalApplicationCumulative[index] ?? 0;
    const rawRows = nationalityIds.map((id) => {
      const recentApplications = cumulativeWindowTotal(
        applicationCumulative.get(id),
        index,
        options.nationalityDemandWindowMonths,
      );
      const cumulativeApplications = applicationCumulative.get(id)?.[index] ?? 0;
      const historicalShare = cumulativeTotalApplications > 0
        ? cumulativeApplications / cumulativeTotalApplications
        : 1 / Math.max(1, nationalityIds.length);
      const demandDenominator = recentTotalApplications
        + options.nationalityDemandPriorApplications;
      const demandShare = demandDenominator > 0
        ? (
          recentApplications
          + options.nationalityDemandPriorApplications * historicalShare
        ) / demandDenominator
        : historicalShare;
      const recentDecisions = cumulativeWindowTotal(
        decisionCumulative.get(id),
        index,
        options.shortWindowMonths,
      );
      const expectedDecisions = recentTotalDecisions * demandShare;
      const reliability = Math.min(
        options.nationalityMaximumWeight,
        expectedDecisions <= 0
          ? 0
          : expectedDecisions
            / (expectedDecisions + options.nationalityPriorDecisions),
      );
      const observedRatio = clamp(
        (recentDecisions + 0.5) / (expectedDecisions + 0.5),
        options.nationalityAllocationFloor,
        options.nationalityAllocationCeiling,
      );
      const score = demandShare * Math.exp(
        reliability * Math.log(observedRatio),
      );
      const observedDecisions = Number(
        decisionSeries.get(id)?.[index] ?? 0,
      );
      return {
        id,
        demandShare,
        reliability,
        score,
        observedDecisions,
      };
    });
    const scoreTotal = sum(rawRows.map((row) => row.score));
    const allocatedRows = rawRows.map((row) => {
      const allocationShare = scoreTotal > 0
        ? row.score / scoreTotal
        : row.demandShare;
      const pooledDecisions = Number(totalDecisions[index] || 0)
        * allocationShare;
      return {
        ...row,
        allocationShare,
        blendedDecisions: row.reliability * row.observedDecisions
          + (1 - row.reliability) * pooledDecisions,
      };
    });
    const blendedTotal = sum(allocatedRows.map((row) => row.blendedDecisions));
    const normalization = blendedTotal > 0
      ? Number(totalDecisions[index] || 0) / blendedTotal
      : 0;

    for (const row of allocatedRows) {
      const service = services.get(row.id);
      service.counts[index] = row.blendedDecisions * normalization;
      service.shares[index] = row.allocationShare;
      service.demandShares[index] = row.demandShare;
      service.reliabilities[index] = row.reliability;
    }
  }

  for (const service of services.values()) {
    const latestShare = service.shares.at(-1) ?? 0;
    const latestDemandShare = service.demandShares.at(-1) ?? 0;
    service.latestShare = latestShare;
    service.latestDemandShare = latestDemandShare;
    service.latestReliability = service.reliabilities.at(-1) ?? 0;
    service.shareAt = (offset) => {
      const persistence = options.nationalityAllocationMeanReversion
        ** Math.max(0, Number(offset));
      return Math.max(
        0,
        latestDemandShare + (latestShare - latestDemandShare) * persistence,
      );
    };
  }

  return services;
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
  let activeCohorts = [];

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
