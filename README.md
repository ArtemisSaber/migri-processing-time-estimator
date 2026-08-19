# Migri processing-time estimator

A conventional Next.js application that estimates average processing time for
Migri application cohorts. It synchronizes a compressed source snapshot from
the configured S3 object, builds a compact static dataset, and presents the
application hierarchy with English names.

This is an independent, unofficial project. It is not affiliated with, endorsed
by, commissioned by, or otherwise connected to the Finnish Immigration Service
(Migri).

The result is an experimental simulation based on aggregate public statistics.
It is not an accurate representation of Migri's actual queues, priorities, or
handling of an individual case, and it does not guarantee a decision, timing,
or outcome.

Nationality is optional. Leaving it blank uses the aggregate application-type
queue. Selecting a citizenship uses that citizenship's own published
applications, decisions, and reconstructed opening stock. Related and global
throughput are capacity signals only: a decision for one citizenship never
consumes another citizenship's modeled inventory.

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

## GitHub Pages deployment

The workflow at `.github/workflows/deploy-pages.yml` validates pull requests and
deploys the static export after every push to `main`. It can also be started
manually from the repository's Actions tab.

The build reads the Pages base path from GitHub's Pages configuration instead of
hard-coding the repository name. `npm run build` writes the deployable site to
`out/`; generated estimator data and the cached source snapshot remain build
artifacts and are not committed.

The deployment requires network access to the public S3 source configured in
`config/estimator.json`.

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

For every complete taxonomy path, the data generator uses a hierarchical,
dynamic cohort model:

1. Reviewed public backlog statements initialize queues that already existed
   when the dataset began. Each statement retains its published qualifier:
   exact statements are hard equalities, lower bounds are hard constraints,
   and approximate statements are fitted without pretending their wording
   supplies false precision. The six compatible family-ties anchors currently
   estimate the combined January 2015 opening stock at 7,803.75 cases. Their
   four approximate snapshots are reproduced within 3.9%, and both published
   lower bounds are satisfied.
2. That stock is reconstructed by citizenship. Every citizenship receives at
   least the opening balance needed to keep its cumulative published decisions
   below cumulative applications plus opening stock for every observed month.
   The remaining stock is distributed using January 2015 application shares.
   The reconstructed citizenship balances meet all hard checkpoint constraints
   and are never allowed to become negative.
3. Each citizenship's opening stock is then apportioned to application types
   using its January 2015 type composition. When that composition is absent,
   the all-citizenship type composition is used as the fallback. This is an
   allocation assumption, not a claim about Migri's internal queue structure.
4. Each application type receives one empirical-Bayes capacity forecast based
   on its recent decisions and throughput movement in related types and the
   rest of the dataset. Recent volatility and sampling uncertainty produce the
   range.
5. That one capacity forecast is allocated across citizenships. Recent
   citizenship decision shares are shrunk toward recent application shares and
   gradually mean-revert toward demand composition. For spouse-of-another-
   foreign-national first permits (`21205/59/1/133`), a path-specific dynamic
   compositional filter instead averages several smoothed service/demand
   estimates, applies a strongly regularized one-month residual correction,
   and rapidly reverts that correction and recent demand signal over longer
   horizons. The path and fitted parameters are explicit in
   `config/estimator.json`. The shares always sum to one, while each share can
   service only its own citizenship's inventory.
6. Published monthly decisions service the initialized backlog and modeled
   application cohorts. Ninety
   percent of capacity is assigned oldest-first; the remainder uses an
   age-weighted hazard so the model does not claim strict real-world FIFO.
7. Future arrivals are included because out-of-order processing lets newer
   cohorts consume some future capacity.

The conservation constraint is enforced at the configured family-ties scope,
where the published checkpoint applies. The public tables do not reconcile
with that checkpoint if every application-type × citizenship cell is treated as
a completely isolated historical stock. The model therefore reports that
type-level split as an assumption while preserving citizenship identity as a
hard constraint. Checkpoints, capacity parameters, and the soft-FIFO share are
explicit in `config/estimator.json`.

The versioned external-anchor catalog is
`config/migri-external-anchors-no-age.json`. Every catalog record is mapped in
`config/estimator.json` as one of four dispositions: calibration, diagnostic,
deferred, or excluded. All 27 records are therefore accounted for, but only the
six structurally compatible family-ties snapshots alter estimates. Study,
citizenship, specialist, Brexit, and asylum snapshots remain visible in the
generated metadata as validation evidence. Turning them into static 2015
opening stock would violate the published stock flows or overstate the latest
queue; those types require a model of unreported removals, scope changes, or a
dated queue reset first. Process-stage counts and the one-off police-transfer
inventory are explicitly excluded.

The S3 URL, cache location, number of selectable submission cohorts, and month-ID
anchor are set in `config/estimator.json`. The first and last selectable months
are always derived from the IDs actually present in the synchronized source.
Cohorts below the configured privacy threshold, or with insufficient recent
decisions, are suppressed.

To use a different estimator configuration:

```bash
node scripts/generate-estimates.mjs /path/to/estimator-config.json
```
