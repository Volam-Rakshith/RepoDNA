# Contributing to RepoDNA

Thanks for helping make repository analysis more honest, useful, and accessible.

## Local development

1. Install Python 3 and a modern browser.
2. Run `python3 -m http.server 4173 --bind 0.0.0.0` or `npm start`.
3. Open `http://localhost:4173`.
4. Run `npm test` before opening a pull request.

There is intentionally no framework or package installation requirement for the core app. Keep the static deployment path healthy.

## Principles

- Prefer evidence from GitHub over heuristics.
- Mark deterministic calculations and inferences visibly.
- Do not call a repository healthy, secure, maintainable, or production-ready from file presence alone.
- Do not add OAuth or request write permissions without a documented, user-approved need.
- Bound API calls and make expensive history reads opt-in.
- Preserve useful partial results when one GitHub endpoint fails.
- Design for keyboard navigation, narrow screens, and slow networks.

## Pull requests

- Keep changes focused and explain any new API call or metric.
- Add or update tests for parsers and pure calculations.
- Test a small repository, an empty/partial response, and a large/truncated tree when practical.
- Do not commit tokens, private repository URLs, generated build folders, or screenshots containing private data.

## Commit style

Use a short imperative subject, for example:

```text
Improve manifest parsing for Cargo workspaces
```

## Reporting issues

Use the bug report or metric proposal issue template. Include the public repository URL only when it is safe to share and useful to reproduce the problem.
