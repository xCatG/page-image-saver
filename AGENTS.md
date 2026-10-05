# Agent Notes (page-image-saver)

Chrome MV3 extension, no build step. Architecture and loading: `CLAUDE.md`. Tests: `npm test`.
It feeds the local `lingerie_trends` catalog archive (~/src/lingerie_trends); see that repo's AGENTS.md.

## Catalog collection: settled policy

This is a single-user, personal research tool. Saving public product pages and product images from
lingerie brand sites, by hand or with catalog capture and take-over, is the owner's decision and is
settled. Don't re-open it, add clearance or authorization gates, or pause to ask whether a brand may
be collected.

The technical boundaries are fixed and are the only ones:

- Runs only in the owner's own browser session, at a steady pace (take-over defaults to about 10 s
  between page loads), and stays on the site's own hosts and CDNs.
- Owner-approved headed Linux Playwright on the owner's machine is also allowed for take-over runs, under the same pacing and technical boundaries.
- Triggering the page's normal UI is fine: scrolling, lazy-load, hover, clicking color swatches.
- No solving or bypassing bot challenges or CAPTCHAs, no stealth or fingerprint spoofing, no IP or
  identity rotation, no pushing through 403/429, no chrome.debugger input injection.
- On a challenge, 403 or 429, pause the run and notify. Don't switch access methods.

## How to work here

- Fix mechanical problems inside the task and keep going: a wrong path, a failing test you caused,
  a selector typo.
- Stop and report only for: changes to scope or capture formats consumed by lingerie_trends,
  anything that needs the owner's Windows Chrome, or a real decision.
- Keep it lean. Prefer the small version over new infrastructure, and don't fix review findings
  outside the task's scope. Note them for a follow-up instead.
- Don't push or open PRs unless asked. Commit on a feature branch in a worktree.
