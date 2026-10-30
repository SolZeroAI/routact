# Routact

<p align="center">
  <a href="https://github.com/SolZeroAI/routact/actions"><img alt="units-test status" src="https://github.com/SolZeroAI/routact/workflows/units-test/badge.svg"></a>
</p>

Route GitHub Actions jobs to your self-hosted runners when they are free, and to a runner of the same OS and CPU architecture when they are not.

GitHub cannot move a job once it is queued, so routing has to happen before the job starts. Routact runs as a small first job that checks your runners through the [self-hosted runners API](https://docs.github.com/en/rest/actions/self-hosted-runners) and outputs labels for `runs-on: ${{ fromJson(...) }}` in later jobs.

Routact started as a fork of [mikehardy/runner-fallback-action](https://github.com/mikehardy/runner-fallback-action) (originally by [@jimmygchen](https://github.com/jimmygchen)) and keeps its inputs and outputs, so it works as a drop-in replacement.

## What it adds

- **Bug fixes.** Busy runners were always skipped even without `primaries-required`; only the first 30 runners were read; a multi-label fallback broke on errors; labels were matched case-sensitively.
- **GitHub App tokens** instead of an org-admin personal access token.
- **Fork pull requests never use self-hosted runners**, and no API call is made for them. They get no secrets anyway, and running untrusted code on self-hosted runners is unsafe.
- **Same-platform fallback.** Routact refuses a fallback whose OS or architecture differs from the primary (for example a Mac pool falling back to `ubuntu-latest`).
- **Several pools in one call**, with shared rules kept in one org variable.
- **Fallback chains** (self-hosted, then Blacksmith, then GitHub-hosted, for example), where each step can have conditions: built-in checks or your own command.
- **Runner claims**, an opt-in lock that stops two concurrent runs from picking the same idle runner.
- **A reusable route job** on `ubuntu-slim`, the smallest and fastest-starting GitHub-hosted runner.
- `node24`, retries and timeouts on API calls, and a job summary table.

## Quick start

### 1. Create a GitHub App for the token

Create a GitHub App owned by your organization (Settings → Developer settings → GitHub Apps) with:

| Needed for | App permission |
| --- | --- |
| Routing with organization runners | Organization → **Self-hosted runners: Read** (Read and write for claims) |
| Routing with repository runners | Repository → **Administration: Read** (Read and write for claims) |
| `github-minutes` checks | Organization → **Administration: Read** |
| [Maintenance](#maintenance) flags and `apply-upgrades` | Organization → **Variables: Read and write** |

After changing an installed App's permissions, an org owner must accept them on the installation (Settings → GitHub Apps → the App → Review request) before tokens include them.

No webhook is needed. Install the App on the organization, then save its id as the org variable `ROUTACT_APP_ID` and its private key as the org secret `ROUTACT_APP_PRIVATE_KEY`.

For enterprise-level runners, use a token with `manage_runners:enterprise` (a personal access token, or an enterprise-installed App if your enterprise has one).

### 2. Put your routing rules in an org variable

Save this as the org variable `ROUTACT_CONFIG` (Settings → Secrets and variables → Actions → Variables):

```json
{
  "organization": "your-org",
  "pools": {
    "linux-x64": { "primary": "self-hosted,Linux,X64", "fallback": "ubuntu-24.04" },
    "linux-arm": { "primary": "self-hosted,Linux,ARM64", "fallback": "ubuntu-24.04-arm", "primaries-required": 1 },
    "mac": { "primary": "self-hosted,macOS,ARM64", "fallback": "macos-15", "primaries-required": 1 }
  }
}
```

Each pool has `primary` labels, `fallback` labels, and optionally `primaries-required` (see [Inputs](#inputs)). Labels can be a comma-separated string or an array.

### 3. Add the route job to a workflow

```yaml
jobs:
  route:
    uses: SolZeroAI/routact/.github/workflows/route.yml@master
    secrets: inherit

  build:
    needs: route
    runs-on: ${{ fromJson(needs.route.outputs.runners)['linux-x64'] }}
    steps:
      - run: echo "Building on ${{ runner.name }}"

  test-mac:
    needs: route
    runs-on: ${{ fromJson(needs.route.outputs.runners)['mac'] }}
    steps:
      - run: echo "Testing on ${{ runner.name }}"
```

One route job serves every pool in the workflow with a single API call.

## Fallback chains

A pool's `fallback` can be an ordered list of steps instead of one label set. Routact uses the first step whose checks all pass:

```json
{
  "pools": {
    "linux-x64": {
      "primary": "self-hosted,Linux,X64",
      "fallback": [
        { "runs-on": "self-hosted,Linux,X64,spare", "when": "idle" },
        { "runs-on": "blacksmith-4vcpu-ubuntu-2404", "when": { "var": "ROUTACT_BLACKSMITH_ENABLED" } },
        { "runs-on": "ubuntu-24.04" }
      ]
    }
  }
}
```

Leave the last step without conditions so there is always somewhere to run. If every step has conditions and all of them fail, Routact uses the last step anyway and says so in the summary.

### Checks

`when` takes one check or a list of checks that must all pass.

| Check | Passes when |
| --- | --- |
| `"idle"` | An online, idle self-hosted runner has the step's labels. `{"idle": 2}` needs two. |
| `{"var": "NAME"}` | The Actions variable `NAME` is set and not `false`, `0`, `no` or `off`. Add `"equals": "value"` to compare exactly. Needs the `vars` input (the reusable workflow passes it). |
| `{"env": "NAME"}` | The environment variable `NAME` is set and truthy. Same options as `var`. |
| `{"command": "..."}` | The shell command exits 0. Use this for your own logic. |
| `"github-minutes"` | The organization's GitHub Actions usage this month is still inside its included minutes. `{"github-minutes": 10}` allows up to $10 of paid usage. See [GitHub-hosted minutes](#github-hosted-minutes). |
| `{"not": check}` | The inner check fails. |
| `{"any": [checks]}` | At least one inner check passes. |

### Your own logic

A `command` check runs with `bash` in the route job and has `check-timeout-seconds` (default 20) to finish. A command that fails, times out or cannot start counts as a failed check. It sees these environment variables:

- `ROUTACT_POOL`: the pool name.
- `ROUTACT_RUNS_ON`: the step's labels as a JSON array.
- `ROUTACT_CHECK_TOKEN`: the `ROUTACT_CHECK_TOKEN` secret, when you use the reusable workflow.

For example, ask your own service whether a provider still has budget:

```json
{ "runs-on": "blacksmith-4vcpu-ubuntu-2404",
  "when": { "command": "curl -fsS -H \"Authorization: Bearer $ROUTACT_CHECK_TOKEN\" https://ci-budget.example.com/blacksmith/ok" } }
```

The route job does not check out your repository, so a command cannot run scripts from it unless you call the action yourself after `actions/checkout`. Commands come from your config, never from pull request code.

### Blacksmith minutes

Each check adds time to every route job, so keep slow checks out of it. For Blacksmith, the fast pattern is a variable flag:

1. Gate the Blacksmith step on `{"var": "ROUTACT_BLACKSMITH_ENABLED"}`.
2. Set the org variable to `false` when the month's minutes run out, and back to `true` when they reset. Do it by hand, or let the [maintenance job](#maintenance) do it with a flag command that runs the [Blacksmith CLI](https://docs.blacksmith.sh/blacksmith-cli/usage) (`blacksmith usage`).

### GitHub-hosted minutes

GitHub-hosted runners are always online, but their minutes are not free once the plan's included minutes are used up. Gate a GitHub-hosted step on `"github-minutes"`, and end the chain on the primary, so a job waits for your own runner instead of running on paid minutes:

```json
"linux-arm": {
  "primary": "self-hosted,Linux,ARM64",
  "primaries-required": 1,
  "fallback": [
    { "runs-on": "blacksmith-4vcpu-ubuntu-2404-arm", "when": { "var": "ROUTACT_BLACKSMITH_ENABLED" } },
    { "runs-on": "ubuntu-24.04-arm", "when": "github-minutes" },
    { "runs-on": "self-hosted,Linux,ARM64" }
  ]
}
```

The check reads the organization's [billing usage summary](https://docs.github.com/en/rest/billing/usage) for the current month and adds up the net amount of the Actions products, which is what you pay after the included minutes. It passes while that amount is 0, or at most the dollar amount you give.

- The App needs the organization permission **Administration: Read**. The reusable workflow asks for it only when the config contains `github-minutes`.
- The route job reads the usage once, however many steps check it.
- When the usage cannot be read (no token, no organization, missing permission, API error), the check fails and the router moves on to the next step.
- GitHub updates billing usage with a delay, so a few jobs can still start on paid minutes right after the included minutes run out.
- The check counts the whole organization. Public repositories use GitHub-hosted runners for free, so do not route them through a pool that ends on a self-hosted runner.

### Where the route job runs

The reusable workflow runs the route job on GitHub's `ubuntu-slim`. When a private repository's GitHub-hosted minutes are used up and the spending limit is reached, GitHub does not start that job, so nothing can be routed. To route from a runner that does not use GitHub's minutes, set the org variable `ROUTACT_ROUTER_RUNS_ON` (or the `runs-on` input) to a JSON label or label array:

```sh
gh variable set ROUTACT_ROUTER_RUNS_ON --org your-org --body '"blacksmith-2vcpu-ubuntu-2404"'
```

Do not point it at a self-hosted pool that the router checks. When that pool is full, the route job would wait behind the jobs it is meant to route away from.

### Fork pull requests

Fork PRs skip the primary and every fallback step labelled `self-hosted`. Other checks still run, so a fork PR can use Blacksmith when it is enabled.

## Using the action directly

The reusable workflow is a thin wrapper. You can call the action yourself, for example with a single pool:

```yaml
jobs:
  route:
    runs-on: ubuntu-slim
    timeout-minutes: 3
    outputs:
      runner: ${{ steps.route.outputs.use-runner }}
    steps:
      - id: app-token
        uses: actions/create-github-app-token@v2
        with:
          app-id: ${{ vars.ROUTACT_APP_ID }}
          private-key: ${{ secrets.ROUTACT_APP_PRIVATE_KEY }}
          permission-organization-self-hosted-runners: read
      - id: route
        uses: SolZeroAI/routact@master
        with:
          github-token: ${{ steps.app-token.outputs.token }}
          organization: your-org
          primary-runner: self-hosted,macOS,ARM64
          fallback-runner: macos-15
          primaries-required: 1
          fallback-on-error: true

  build:
    needs: route
    runs-on: ${{ fromJson(needs.route.outputs.runner) }}
    steps:
      - run: echo "Building"
```

Keep the route job on a GitHub-hosted runner. If it ran on the self-hosted pool it is checking, it could never route away from that pool when the pool is full.

Fork pull requests get no secrets, so the token step fails for them. Add `if: github.event.pull_request.head.repo.full_name == github.repository || github.event_name != 'pull_request'` to the token step; Routact sends fork PRs to the fallback without a token. The reusable workflow already does this.

## Runner claims

With `primaries-required`, two workflows that start together can both see the same idle runner and both route to it, so one waits. Upstream suggested a `concurrency` group plus `sleep 15`, which serializes every run and still guesses at timing.

With `claim: true`, Routact instead:

1. Picks an idle runner that has no live claim, and adds a unique label to it, such as `routact-claim-1793750400-123456-1-k3x9zq`.
2. Reads the runner again. If its claim is the only live claim, it wins. If another run claimed the runner at the same moment, both back off and try the next idle runner (or fall back). Two runs can both lose a race, but never both win.
3. Outputs the claim label as the runner label, so the job can only run on that exact runner.

Claims expire after `claim-ttl-minutes` (default 10) and are removed by the next route job. To free the runner sooner, release the claim at the end of the job:

```yaml
  build:
    needs: route
    runs-on: ${{ fromJson(needs.route.outputs.runners)['mac'] }}
    steps:
      - run: make build
      - name: Release runner claim
        if: always() && needs.route.outputs.claims != ''
        uses: SolZeroAI/routact@master
        with:
          release: ${{ needs.route.outputs.claims }}
          organization: your-org
          github-token: ${{ secrets.ROUTACT_TOKEN }}  # or an App token with write access
```

Things to know:

- Claims need **write** access to runners (App permission Self-hosted runners: Read and write).
- A claimed job targets one runner. If that runner goes offline before the job starts, the job waits until it times out, so set `timeout-minutes` on jobs that use claims.
- Runners whose labels cannot be edited (for example Actions Runner Controller scale sets) cannot be claimed.

## Maintenance

A scheduled maintenance job keeps the org settings honest. It runs the action with `mode: maintain` through the reusable workflow `.github/workflows/maintain.yml`, on the same runner as the route job (`ROUTACT_ROUTER_RUNS_ON`, else `ubuntu-slim`). It has three tasks:

| Task | What it does |
| --- | --- |
| `validate` | Checks `ROUTACT_CONFIG` against the registered runners. It fails on an invalid config or a fallback with another OS or architecture, and warns about pools with no registered or online runners, and about `var` checks on variables that are not set. |
| `images` | Checks every GitHub-hosted label in the fallbacks against the current [runner-images](https://github.com/actions/runner-images) list. It fails on retired or deprecated labels, warns about beta and preview images, and suggests the newest generally available label of the same kind (for example `ubuntu-24.04` to `ubuntu-26.04`, or `macos-15-intel` to `macos-26-intel`). The suggested config is in the job summary and the `suggested-config` output. It changes `ROUTACT_CONFIG` only with `apply-upgrades: true`, because a new image can break builds. |
| `flags` | Runs each command in the org variable `ROUTACT_FLAGS` and sets the named org variable to `true` when it exits 0, else `false`. This is how slow checks such as Blacksmith minutes stay out of the route job. |

`ROUTACT_FLAGS` maps variable names to checks. A check is a shell command (exit 0 sets `true`) or the built-in Blacksmith budget check:

```json
{
  "ROUTACT_BLACKSMITH_ENABLED": { "blacksmith": { "budget-usd": 250 } },
  "ROUTACT_BUDGET_OK": "curl -fsS -H \"Authorization: Bearer $ROUTACT_CHECK_TOKEN\" https://ci-budget.example.com/ok"
}
```

The **Blacksmith check** sets the variable to `true` while this calendar month's (UTC) Blacksmith usage is below every limit you give: `budget-usd` (compared with `cost_usd`) and `max-billing-minutes` (compared with `billing_minutes`). It downloads the Blacksmith CLI, verifies its checksum, signs in with the org secret `BLACKSMITH_API_TOKEN` (create an organization token in Blacksmith), and reads `blacksmith usage`. Add `"organization": "<slug>"` if your Blacksmith organization slug differs from the GitHub organization name.

If a check cannot run (no token, network error), the variable keeps its last value and the job reports a problem, so a blip never flips routing.

Shell commands get `ROUTACT_ORGANIZATION` and, through the reusable workflow, the `ROUTACT_CHECK_TOKEN` secret. Each check has 120 seconds.

To schedule it, call the reusable workflow from one repository (SolZeroAI's runs from this repository, see `.github/workflows/solzero-maintain.yml`):

```yaml
on:
  schedule:
    - cron: '17 * * * *'   # hourly: flags only
    - cron: '23 6 * * *'   # daily: everything
  workflow_dispatch:
jobs:
  maintain:
    uses: SolZeroAI/routact/.github/workflows/maintain.yml@master
    secrets: inherit
    with:
      tasks: ${{ github.event.schedule == '17 * * * *' && 'flags' || '' }}
```

Setting variables needs the GitHub App's organization permission **Variables: Read and write**. Validation needs only Self-hosted runners: Read. Problems fail the job, so GitHub's failed-workflow email tells you about them.

## Inputs

| Name | Default | Description |
| --- | --- | --- |
| `github-token` | | Token that can read runners for the chosen scope. Not needed for fork PRs. |
| `primary-runner` | | Comma-separated labels of the primary runner, e.g. `self-hosted,Linux,X64`. Use with `fallback-runner`, or use `config`. |
| `fallback-runner` | | Comma-separated labels of the fallback, e.g. `ubuntu-24.04`. Use `config` for a [fallback chain](#fallback-chains). |
| `primaries-required` | | Fall back unless at least this many matching primaries are online **and idle**. Empty means any online primary is enough, even a busy one. |
| `config` | | JSON routing rules with named pools (see Quick start). |
| `pools` | all | Comma-separated pool names from `config` to route. |
| `vars` | | Variables for `var` checks: `${{ toJSON(vars) }}`. |
| `check-timeout-seconds` | `20` | Time limit for each `command` check. |
| `organization` | | Check this organization's runners. Default is the repository's runners, or the `organization` in `config`. |
| `enterprise` | | Check this enterprise's runners. |
| `fallback-on-error` | `false` | Use the fallback if the runner check fails (expired token, API outage). Configuration errors still fail the job. |
| `fallback-on-fork-pr` | `true` | Never use self-hosted runners for pull requests from forks. |
| `platform-check` | `error` | When the fallback's OS or architecture differs from the primary: `error`, `warn` or `off`. |
| `claim` | `false` | Claim a specific idle runner (see [Runner claims](#runner-claims)). |
| `claim-ttl-minutes` | `10` | Minutes before an unreleased claim expires. |
| `release` | | Release these claims instead of routing. |
| `mode` | `route` | `maintain` runs the [maintenance](#maintenance) tasks instead of routing. |
| `tasks` | all | Maintenance tasks: `validate`, `images`, `flags`. |
| `flags` | | Maintenance: JSON object of org variable name to shell command. |
| `apply-upgrades` | `false` | Maintenance: write newer GitHub-hosted labels into `ROUTACT_CONFIG`. |

## Outputs

| Name | Description |
| --- | --- |
| `use-runner` | JSON label array for `runs-on`, read with `fromJson`. Set when exactly one pool is routed. |
| `is-primary` | `true` when the primary was chosen (single pool). |
| `fallback-step` | Which fallback step was used, counting from 1; `0` for the primary (single pool). |
| `runner-name` | The chosen runner's name, when known (single pool). |
| `reason` | Why this runner was chosen (single pool). |
| `runners` | JSON object of pool name to label array. The single-pool inputs use the pool name `default`. |
| `details` | JSON object of pool name to `{labels, isPrimary, fallbackStep, runnerName, claim, reason}`. |
| `claims` | Comma-separated claims made by this run, for `release`. |
| `problems` | Maintenance: number of problems found. |
| `suggested-config` | Maintenance: `ROUTACT_CONFIG` with newer GitHub-hosted labels, when there are any. |

## How the platform check works

Routact works out each side's OS and architecture:

- For a registered self-hosted runner, from the OS it reports and its `X64`/`ARM64` label.
- For GitHub-hosted labels, from the image name: `ubuntu-*` is Linux X64, `*-arm` is ARM64, `macos-14` and newer are Apple silicon, `macos-13`, `*-intel` and `*-large` are Intel, `windows-*` is Windows X64.
- For other providers, from words in the label such as `ubuntu`, `macos`, `arm64` or `x64`.

If either side cannot be fully determined, Routact warns instead of failing. Add the default OS and architecture labels (for example `Linux,X64`) to your primary labels to make the check exact.

## Development

```bash
npm ci
npm run all   # lint, build dist/, test
```

`dist/` is checked in because Actions runs it directly; rebuild it with `npm run prepare` before committing.

## Credit

- Based on the pattern described by @ianpurton on [this feature request thread](https://github.com/orgs/community/discussions/20019#discussioncomment-5414593).
- Originally developed by @jimmygchen, continued by @mikehardy as [runner-fallback-action](https://github.com/mikehardy/runner-fallback-action).
- @O-Mutt contributed the organization-level and enterprise-level runner support.
