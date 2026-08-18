import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const configPath = resolve(
  process.cwd(),
  process.argv[2] ?? "config/estimator.json",
);
const config = JSON.parse(readFileSync(configPath, "utf8"));
const sourceUrl = new URL(config.sourceUrl);
const cachePath = resolve(process.cwd(), config.sourceFile);
const statePath = resolve(process.cwd(), config.sourceStateFile);

if (sourceUrl.protocol !== "https:") {
  throw new Error("The configured source URL must use HTTPS.");
}

function validateSource(buffer) {
  if (buffer[0] !== 0x1f || buffer[1] !== 0x8b) {
    throw new Error("The configured source must be a gzip file.");
  }

  const source = JSON.parse(gunzipSync(buffer).toString("utf8"));
  const applicationMonths = Object.keys(source.applications ?? {})
    .sort((left, right) => Number(left) - Number(right));
  const decisionMonths = Object.keys(source.decisions ?? {})
    .sort((left, right) => Number(left) - Number(right));

  if (
    applicationMonths.length === 0 ||
    applicationMonths.join(",") !== decisionMonths.join(",")
  ) {
    throw new Error("The source must contain aligned applications and decisions months.");
  }

  return {
    monthCount: applicationMonths.length,
    firstMonthId: applicationMonths[0],
    lastMonthId: applicationMonths.at(-1),
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function atomicWrite(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, contents);
  renameSync(temporaryPath, path);
}

let cachedSource;
if (existsSync(cachePath)) {
  try {
    cachedSource = validateSource(readFileSync(cachePath));
  } catch {
    cachedSource = undefined;
  }
}

const previousState = readJson(statePath);
const requestHeaders = {};
if (cachedSource && previousState?.sourceUrl === sourceUrl.href) {
  if (previousState.etag) requestHeaders["If-None-Match"] = previousState.etag;
  if (previousState.lastModified) {
    requestHeaders["If-Modified-Since"] = previousState.lastModified;
  }
}

try {
  const response = await fetch(sourceUrl, { headers: requestHeaders });

  if (response.status === 304 && cachedSource) {
    console.log(
      `Source cache is current (${cachedSource.monthCount} months, ${cachedSource.sha256.slice(0, 12)}).`,
    );
    process.exit(0);
  }
  if (!response.ok) {
    throw new Error(`Source request failed with HTTP ${response.status}.`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const sourceInfo = validateSource(buffer);
  const nextState = {
    sourceUrl: sourceUrl.href,
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
    sha256: sourceInfo.sha256,
    monthCount: sourceInfo.monthCount,
    firstMonthId: sourceInfo.firstMonthId,
    lastMonthId: sourceInfo.lastMonthId,
    syncedAt: new Date().toISOString(),
  };

  atomicWrite(cachePath, buffer);
  atomicWrite(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
  console.log(
    `Synced ${sourceInfo.monthCount} months from S3 (${sourceInfo.sha256.slice(0, 12)}).`,
  );
} catch (error) {
  if (!cachedSource) throw error;
  console.warn(
    `Source sync unavailable; using validated cache (${cachedSource.monthCount} months). ${error.message}`,
  );
}
