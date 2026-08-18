"use client";

import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import typeNames from "@/config/type-names.json";
import generatedData from "@/data/estimates.json";

type Confidence = "high" | "medium" | "low";

type Estimate = {
  months: number;
  lowerMonths: number;
  upperMonths: number;
  observedShare: number;
  confidence: Confidence;
};

type ApplicationPath = {
  path: string;
  levels: string[];
  groupCodes: string[];
  estimates: Record<string, Estimate | null>;
  nationalityEstimates: Partial<
    Record<string, Partial<Record<string, Estimate | null>>>
  >;
};

type EstimatorData = {
  metadata: {
    sourceFile: string;
    sourceThrough: string;
    monthMapping: string;
    historyMonths: number;
    rollingWindowMonths: number;
    suppressionThreshold: number;
    model: string;
  };
  months: Array<{ id: string; period: string }>;
  nationalities: Record<string, string>;
  paths: ApplicationPath[];
};

type TypeNameNode = {
  name?: string;
  children?: Record<string, TypeNameNode>;
};

const data = generatedData as EstimatorData;
const configuredHierarchy = typeNames.hierarchy as Record<string, TypeNameNode>;

const GROUP_LABELS: Record<string, string> = {
  ASIARYHMA_ID: "Case group",
  ASIA_TYYPPI_ID: "Application type",
  KASITTELYPERUSTE_TASO_ID: "Basis level",
  KASITTELYPERUSTE_ID: "Detailed type",
};

const MONTH_FORMATTER = new Intl.DateTimeFormat("en", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

function formatPeriod(period: string) {
  return MONTH_FORMATTER.format(new Date(`${period}-01T00:00:00Z`));
}

function unique(values: string[]) {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );
}

function configuredNode(levels: string[]) {
  let children = configuredHierarchy;
  let node: TypeNameNode | undefined;

  for (const id of levels) {
    node = children[id];
    if (!node) return undefined;
    children = node.children ?? {};
  }

  return node;
}

function optionName(prefix: string[], id: string) {
  return configuredNode([...prefix, id])?.name?.trim() || `ID ${id}`;
}

function confidenceLabel(confidence: Confidence) {
  return `${confidence[0].toUpperCase()}${confidence.slice(1)}`;
}

export default function Home() {
  const preferredPath = data.paths.find((item) => item.path === "21205/59/1/133");
  const [selectedPathId, setSelectedPathId] = useState(
    preferredPath?.path ?? data.paths[0]?.path ?? "",
  );
  const [nationalityId, setNationalityId] = useState("");
  const [month, setMonth] = useState(data.metadata.sourceThrough);

  const selectedPath = useMemo(
    () => data.paths.find((item) => item.path === selectedPathId) ?? data.paths[0],
    [selectedPathId],
  );
  const result = nationalityId
    ? selectedPath?.nationalityEstimates[nationalityId]?.[month] ?? null
    : selectedPath?.estimates[month] ?? null;
  const selectedApplicationName = (selectedPath?.levels ?? [])
    .map((_, index) => (
      configuredNode(selectedPath.levels.slice(0, index + 1))?.name?.trim()
    ))
    .filter((name): name is string => Boolean(name))
    .join(" → ");
  const nationalityChoices = Object.keys(
    selectedPath?.nationalityEstimates ?? {},
  ).sort((left, right) => (
    data.nationalities[left] ?? left
  ).localeCompare(data.nationalities[right] ?? right));
  const selectedNationalityName = nationalityId
    ? data.nationalities[nationalityId] ?? `Citizenship ID ${nationalityId}`
    : "";
  const monthIndex = Math.max(
    0,
    data.months.findIndex((item) => item.period === month),
  );
  const monthProgress = data.months.length > 1
    ? (monthIndex / (data.months.length - 1)) * 100
    : 0;

  function selectLevel(levelIndex: number, id: string) {
    const prefix = [...selectedPath.levels.slice(0, levelIndex), id];
    const nextPath = data.paths.find((item) =>
      prefix.every((value, index) => item.levels[index] === value),
    );
    if (nextPath) {
      setSelectedPathId(nextPath.path);
      if (nationalityId && !nextPath.nationalityEstimates[nationalityId]) {
        setNationalityId("");
      }
    }
  }

  const scaleMax = result
    ? Math.max(9, Math.ceil(result.upperMonths / 3) * 3)
    : 9;
  const rangeLeft = result ? Math.min(96, (result.lowerMonths / scaleMax) * 100) : 0;
  const rangeWidth = result
    ? Math.max(4, ((result.upperMonths - result.lowerMonths) / scaleMax) * 100)
    : 0;
  const pointLeft = result ? Math.min(98, (result.months / scaleMax) * 100) : 0;

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Migri Wait Estimate home">
          <span className="brand-mark" aria-hidden="true">M</span>
          <span>Migri Wait Estimate</span>
        </a>
        <a className="method-link" href="#method">How this works <span aria-hidden="true">↘</span></a>
      </header>

      <aside className="independence-notice" aria-label="Independent project disclaimer">
        <strong>Independent and unofficial</strong>
        <p>
          This project is not affiliated with, endorsed by, commissioned by, or otherwise connected to the Finnish Immigration Service (Migri).
        </p>
      </aside>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow"><span /> Public data · Experimental</p>
          <h1>A clearer idea of how long you might wait.</h1>
          <p className="lede">
            Select the taxonomy IDs for an application and its submission month.
            The estimator turns Migri&apos;s public statistics into a rough waiting-time range.
          </p>
        </div>
        <div className="hero-note" aria-label="Important note">
          <span className="note-number">01</span>
          <p>Public statistics power an experimental model—not access to Migri&apos;s internal systems or case queue.</p>
        </div>
      </section>

      <section className="estimator" aria-labelledby="estimator-title">
        <div className="form-panel">
          <div className="panel-heading">
            <p className="step-kicker">Your application</p>
            <h2 id="estimator-title">Choose the application IDs</h2>
          </div>

          <div className="field-stack">
            {selectedPath?.levels.map((selectedId, levelIndex) => {
              const prefix = selectedPath.levels.slice(0, levelIndex);
              const choices = unique(
                data.paths
                  .filter((item) =>
                    prefix.every((value, index) => item.levels[index] === value),
                  )
                  .map((item) => item.levels[levelIndex])
                  .filter((value): value is string => Boolean(value)),
              );
              const groupCode = selectedPath.groupCodes[levelIndex] ?? "UNKNOWN";

              return (
                <label key={`${groupCode}-${levelIndex}`}>
                  <span>{GROUP_LABELS[groupCode] ?? `Taxonomy level ${levelIndex + 1}`}</span>
                  <select
                    value={selectedId}
                    onChange={(event) => selectLevel(levelIndex, event.target.value)}
                  >
                    {choices.map((id) => (
                      <option key={id} value={id}>{optionName(prefix, id)}</option>
                    ))}
                  </select>
                </label>
              );
            })}

            <label>
              <span>Nationality (optional)</span>
              <select
                value={nationalityId}
                aria-describedby="nationality-note"
                onChange={(event) => setNationalityId(event.target.value)}
              >
                <option value="">All nationalities</option>
                {nationalityChoices.map((id) => (
                  <option key={id} value={id}>
                    {data.nationalities[id] ?? `Citizenship ID ${id}`} · ID {id}
                  </option>
                ))}
              </select>
              <small id="nationality-note" className="nationality-note">
                Experimental: selecting a citizenship models it as a separate FIFO queue.
              </small>
            </label>

            <div className="month-slider-field">
              <span className="month-slider-heading">
                <label htmlFor="submission-month">Submission month</label>
                <output htmlFor="submission-month">{formatPeriod(month)}</output>
              </span>
              <span className="month-slider-control">
                <span className="month-slider-ticks" aria-hidden="true">
                  {data.months.map((item) => <i key={item.period} />)}
                </span>
                <input
                  id="submission-month"
                  type="range"
                  min="0"
                  max={Math.max(0, data.months.length - 1)}
                  step="1"
                  value={monthIndex}
                  aria-valuetext={formatPeriod(month)}
                  style={{ "--slider-progress": `${monthProgress}%` } as CSSProperties}
                  onChange={(event) => {
                    const selectedMonth = data.months[Number(event.target.value)];
                    if (selectedMonth) setMonth(selectedMonth.period);
                  }}
                />
              </span>
              <span className="month-slider-bounds" aria-hidden="true">
                <small>{formatPeriod(data.months[0].period)}</small>
                <small>{formatPeriod(data.months.at(-1)!.period)}</small>
              </span>
            </div>
          </div>

          <div className="selected-path">
            <span>Selected application</span>
            <b>{selectedApplicationName || "Application selected"}</b>
          </div>
          <p className="mapping-note">
            The complete ID tree is generated from the statistics export and populated from Migri&apos;s English codebook snapshot.
          </p>
          <p className="privacy-note"><span aria-hidden="true">●</span> Groups smaller than {data.metadata.suppressionThreshold} are not estimated.</p>
        </div>

        <div className="result-panel" aria-live="polite">
          {result ? (
            <>
              <div className="result-topline">
                <p>Estimated processing time</p>
                <span className={result.observedShare >= 0.99 ? "status observed" : "status"}>
                  {result.observedShare >= 0.99 ? "Observed" : "Model estimate"}
                </span>
              </div>
              <div className="result-number">
                <strong>{result.months.toFixed(1)}</strong>
                <span>months</span>
              </div>
              <p className="range-copy">
                A practical range is about <b>{result.lowerMonths.toFixed(1)}–{result.upperMonths.toFixed(1)} months</b>.
              </p>

              <div className="range-plot" aria-label={`Estimated range ${result.lowerMonths.toFixed(1)} to ${result.upperMonths.toFixed(1)} months`}>
                <div className="range-scale">
                  <span>0</span>
                  <span>{scaleMax / 3}</span>
                  <span>{(scaleMax * 2) / 3}</span>
                  <span>{scaleMax}+ months</span>
                </div>
                <div className="range-track">
                  <span className="range-fill" style={{ left: `${rangeLeft}%`, width: `${rangeWidth}%` }} />
                  <span className="range-point" style={{ left: `${pointLeft}%` }} />
                </div>
              </div>

              <div className="result-context">
                <div><span>Submitted</span><b>{formatPeriod(month)}</b></div>
                <div><span>Data through</span><b>{formatPeriod(data.metadata.sourceThrough)}</b></div>
                <div><span>Confidence</span><b>{confidenceLabel(result.confidence)}</b></div>
              </div>

              <p className="result-footnote">
                {nationalityId ? `This view treats ${selectedNationalityName} as a separate queue; the public data does not confirm that Migri assigns work this way. ` : ""}
                {Math.round(result.observedShare * 100)}% of this cohort&apos;s modeled processing is covered by observed decision months. The remainder uses the latest {data.metadata.rollingWindowMonths}-month average capacity.
              </p>

              <div className="estimate-disclaimer">
                <strong>What this estimate cannot tell you</strong>
                <p>
                  This simulation is not an accurate representation of Migri&apos;s actual queues, priorities, or handling of an individual case. It does not guarantee a decision, timing, or outcome.
                </p>
              </div>
            </>
          ) : (
            <div className="unavailable">
              <p className="step-kicker">Estimate unavailable</p>
              <h2>Not enough public data for this month.</h2>
              <p>
                This cohort is below the privacy threshold or has too little recent decision capacity for a responsible estimate. Try another month or application path.
              </p>
            </div>
          )}
        </div>
      </section>

      <section className="method" id="method">
        <p className="eyebrow"><span /> The method</p>
        <div className="method-grid">
          <h2>Public statistics in.<br />A useful range out.</h2>
          <ol>
            <li><span>01</span><div><b>Count incoming applications</b><p>Applications are grouped by their full taxonomy path and submission month.</p></div></li>
            <li><span>02</span><div><b>Measure recent capacity</b><p>Future decisions use a rolling six-month capacity; three- and twelve-month windows form the range.</p></div></li>
            <li><span>03</span><div><b>Simulate a FIFO queue</b><p>Observed decisions clear the oldest modeled applications first. Real Migri cases are not always processed strictly in order.</p></div></li>
          </ol>
        </div>
      </section>

      <footer>
        <span>Migri Wait Estimate · Independent and unaffiliated</span>
        <span>Month-ID mapping: {data.metadata.monthMapping}</span>
      </footer>
    </main>
  );
}
