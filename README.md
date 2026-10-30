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

| Runners you check | App permission |
| --- | --- |
| Organization runners | Organization → **Self-hosted runners: Read** (Read and write for claims) |
| Repository runners | Repository → **Administration: Read** (Read and write for claims) |

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
2. Set the org variable to `false` when the month's minutes run out, and back to `true` when they reset. You can do it by hand, or with a scheduled workflow that runs the [Blacksmith CLI](https://docs.blacksmith.sh/blacksmith-cli/usage) (`blacksmith usage`) and updates the variable with `gh variable set`.

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
