# Migri processing-time estimator

A conventional Next.js application that estimates average processing time for
Migri application cohorts. It synchronizes a compressed source snapshot from
the configured S3 object, builds a compact static dataset, and presents a
hierarchy of taxonomy IDs to the user.

This is an independent, unofficial project. It is not affiliated with, endorsed
by, commissioned by, or otherwise connected to the Finnish Immigration Service
(Migri).

The result is an experimental simulation based on aggregate public statistics.
It is not an accurate representation of Migri's actual queues, priorities, or
handling of an individual case, and it does not guarantee a decision, timing,
or outcome.

Nationality is optional. Leaving it blank uses the aggregate application-type
queue. Selecting a citizenship recalculates arrivals, decisions, and capacity
for that citizenship as an experimental separate-queue scenario; the public
data does not establish that Migri actually assigns work this way.

## Requirements

- Node.js 20.9 or newer
- Network access to the configured public S3 object, or an existing validated
  cache at `data/source/migri-statistics.json.gz`

## Run locally

```bash
npm install
npm run dev
```

`npm run dev` conditionally synchronizes the source, regenerates the compact
estimator data, and starts Next.js. Open `http://localhost:3000` after the
server starts.

To synchronize and regenerate manually:

```bash
npm run generate:data
```

`generate:data` runs `sync:data` first. Run `npm run sync:data` by itself only
when you want to refresh the cached source without regenerating estimates.

The synchronizer uses S3 ETag and Last-Modified metadata, validates the gzip and
its application/decision month structure, and replaces the cache atomically.
If S3 is temporarily unavailable, generation continues with the last validated
cache. The website itself never requests S3 at runtime.

Useful checks:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

## Taxonomy names

`npm run generate:data` derives the complete taxonomy hierarchy from the source
JSON and writes it to `config/type-names.json`. English taxonomy and citizenship
names are filled from `config/migri-codebook.en.json`, which was extracted from
the official Migri statistical service bundle. Every discovered taxonomy ID
remains represented as a nested node:

```json
{
  "hierarchy": {
    "21205": {
      "name": "Residence permit",
      "children": {
        "59": {
          "name": "First residence permit to Finland",
          "children": {
            "1": {
              "name": "Family",
              "children": {
                "133": {
                  "name": "Spouse of other foreign national",
                  "children": {}
                }
              }
            }
          }
        }
      }
    }
  }
}
```

The generator preserves an existing non-empty name, fills new or blank names
from the official codebook, adds newly discovered IDs, and removes branches no
longer present in the source.

To refresh the codebook from a newly downloaded Migri JavaScript bundle:

```bash
npm run update:labels -- /path/to/migri-statistics-bundle.js config/migri-codebook.en.json
npm run generate:data
```

## Estimation model

For every complete taxonomy path, the data generator:

1. Reconstructs the monthly queue from applications and decisions.
2. Assigns decisions to the oldest applications first (FIFO).
3. Uses observed decisions where available.
4. Projects unfinished cohorts with the latest six-month average capacity.
5. Uses three- and twelve-month capacities to form a rough range.

When a nationality is selected, the same calculation is run using only that
citizenship's monthly applications and decisions within the selected taxonomy
path.

The S3 URL, cache location, number of selectable submission cohorts, and month-ID
anchor are set in `config/estimator.json`. The first and last selectable months
are always derived from the IDs actually present in the synchronized source.
Cohorts below the configured privacy threshold, or with insufficient recent
decisions, are suppressed.

To use a different estimator configuration:

```bash
node scripts/generate-estimates.mjs /path/to/estimator-config.json
```
