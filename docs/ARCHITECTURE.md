# RepoDNA architecture

RepoDNA is a static, local-first web application. There is no RepoDNA backend in the reference implementation.

## Request flow

```text
URL / owner-repository input
        │
        ▼
strict parser ── rejects non-GitHub, profile, issue, and PR URLs
        │
        ▼
GET /repos/:owner/:repo
        │
        ├── /languages
        ├── /git/trees/:default_branch?recursive=1
        ├── /commits?per_page=100
        ├── /contributors?per_page=10&anon=true
        ├── /branches?per_page=15
        ├── /releases?per_page=8
        └── /tags?per_page=8
              │
              ▼
     bounded public manifest reads
     raw.githubusercontent.com
              │
              ▼
     deterministic in-browser analysis
              │
              ├── signature radar + evidence cards
              ├── file tree + largest files
              ├── languages + dependency surface
              ├── activity timeline + milestones
              └── optional lazy history reads
```

## API and rate-limit strategy

- The metadata request is made first so a 404, private repository, or rate-limit error gets a useful explanation before any parallel work starts.
- Small metadata responses are cached in `sessionStorage` for five minutes to avoid repeat scans during a session. Large recursive trees, commit details, and statistics are intentionally not cached.
- The seven baseline endpoint requests run in parallel with `Promise.allSettled`. One unavailable endpoint does not throw away every other observation.
- The recursive tree is capped at the first 2,200 returned blobs for rendering and clearly marks GitHub's `truncated` response or the local display cap.
- Up to five known manifests are read from the public raw endpoint, each clipped to 180 KB before parsing.
- File-level churn is a user-triggered request for details of the latest 15 commits. It is never requested during the initial scan.
- Code growth is a user-triggered request to `/stats/code_frequency`. GitHub can return HTTP 202 while it computes the statistic; the UI displays a deferred state rather than polling.
- The `x-ratelimit-remaining` response header is shown as an informational API budget badge.

## Analysis model

Each dimension is an object with:

```js
{
  id,
  label,
  score,      // normalized signal for visual comparison, not a quality rating
  type,       // observed | calculated | inferred
  inputs,     // human-readable observed inputs
  formula,    // deterministic calculation explanation
  caveat      // explicit limit of the signal
}
```

### Dimension definitions

- **Technology**: dominant language share plus the number of detected manifest/config toolchain indicators. A language mix is not a maintainability score.
- **Architecture**: directory breadth, maximum path depth, and whether the repository has a meaningful root surface. This describes topology, not module quality.
- **Activity**: the latest 100 public commits normalized against a 12 commits/week reference. It is a recent sample, not lifetime history.
- **Dependency**: declared dependency names parsed from supported manifests plus manifest coverage. Lockfile contents and optional groups affect visibility.
- **Documentation**: README presence, docs directory presence, and markup file count. Content quality is deliberately not scored.
- **Testing**: test-like paths and test configuration filenames. Presence does not prove coverage or passing tests.
- **Evolution**: repository age, visible release/tag markers, and recent sample cadence. Historical growth is not fetched automatically.
- **Collaboration**: contributor rows, visible branch rows, and contribution spread where contributor counts are available. Pagination and anonymous users limit it.

## Rendering boundaries

- SVG is used for the DNA signature, commit pulse, and growth chart so every point remains inspectable and exportable.
- The file tree is native `<details>` / `<summary>` markup for keyboard and mobile support.
- The UI uses system fonts and embedded CSS/SVG only; it does not depend on a CDN to render the core experience.
- Exported SVG is serialized from the current signature chart. PNG uses a browser canvas conversion of that SVG.

## Failure semantics

The UI distinguishes:

- invalid input before a request
- 404 / private / unavailable repository
- rate limiting
- endpoint-level incomplete metadata
- GitHub's truncated tree
- GitHub's deferred statistics endpoint
- network failure

Missing data stays missing. The analysis layer never substitutes a guessed value for an unavailable response.
