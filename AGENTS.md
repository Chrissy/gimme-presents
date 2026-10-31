# GimmePresents working agreements

Keep the UI and anonymous ownership simple. Enforce resource usage limits and
handle exhausted allowances gracefully.

## PR bases and stacked work

- Base new PRs on freshly fetched `origin/master` by default. Obtain explicit
  agreement before creating a PR that targets another unmerged PR's branch.
- Before starting stacked work, prominently identify the proposed base and the
  full dependency chain. Mentioning a stack in a long status update or footnote
  is not a substitute for agreement to use that workflow.
- Prefix stacked PR titles with `[STACKED on #<number>]`. Label an integration
  PR that contains merged child PRs as `[STACK ROOT]`, and keep its title and
  description current as the scope changes. Do not present it as merely a
  deployment step.
- When working with stacked PRs, end every final response with a prominent
  **🔴 STACKED PRS — NOT YET IN MASTER** callout and a bulleted list of the full
  stack. Each bullet must include the PR link, open/merged status, and actual
  target branch or parent PR. This must be the final visible content, not buried
  in prose, a footnote, a collapsed section, or a long summary.
- Always state where a PR was merged. A child merged into a parent branch is
  still outside `master` until the parent lands. Do not describe that as merged
  into main or ready to deploy from main.

## Production releases

- Implement changes on a branch, test them, and open/update a PR for the user's
  review. Approval to write code, add safeguards, fix a bug, or create a PR is
  **not** approval to merge or deploy it.
- The user reviews and merges PRs. Do not merge a PR unless the user explicitly
  asks you to merge that specific PR.
- Deploy only after an explicit deployment request for the reviewed, merged
  code. Fetch `origin/master` (this repository's main branch), verify the PR is
  merged into it and CI passed, and state the exact commit to be deployed.
- The deploy checkout must be clean and HEAD must equal the freshly fetched
  `origin/master`. Use `npm run deploy`, which checks these conditions before
  building/uploading. Do not bypass the check with direct Wrangler commands,
  alternate branches, generated bundles, or API calls.
- If new code is needed during deployment preparation, return it to a PR for
  review and merge. The earlier deployment request does not cover the new code.
- Production D1 migrations, data writes, R2 operations, configuration changes,
  and rollbacks also need authorization for that release/scope. Preview builds,
  local simulated storage, tests, and deployment dry runs are not live releases.
- Report separately what was written, committed/pushed, opened as a PR, merged,
  deployed, and verified live. Never say a PR is "in" merely because its branch
  was deployed. If verification is incomplete, say so.

## Usage limits

Keep budgets atomic, global across all users/hostnames, and enforced before the
operation they protect. Count failed/uncertain work conservatively. Do not add
new paid services or upgrade Workers Free without explicit approval. Preserve
existing lists and the established ownership flow.

## Public documentation

This repository is open source. Keep documentation and PR descriptions focused
on project behavior and technical requirements. Do not include personal details
from conversations, usage patterns tied to individuals, financial circumstances,
account contact information, or private operational commentary.
