const core = require("@actions/core")
const { RunnerClient, apiPathFor, fetchActionsSpend } = require("./src/github")
const { parseConfig, resolvePools } = require("./src/config")
const { isForkPullRequest } = require("./src/event")
const { ConfigError, routePools, fallbackResults, parseClaims } = require("./src/route")
const { parseVars } = require("./src/checks")

const PLATFORM_CHECKS = ["error", "warn", "off"]

function readInputs() {
  const config = parseConfig(core.getInput("config"))
  const platformCheck = (core.getInput("platform-check") || "error").toLowerCase()

  if (!PLATFORM_CHECKS.includes(platformCheck)) {
    throw new ConfigError(
      `platform-check must be one of ${PLATFORM_CHECKS.join(", ")}, got "${platformCheck}"`,
    )
  }

  const claimTtlMinutes = Number(core.getInput("claim-ttl-minutes") || 10)

  if (!(claimTtlMinutes > 0)) {
    throw new ConfigError(
      `claim-ttl-minutes must be a positive number, got "${core.getInput("claim-ttl-minutes")}"`,
    )
  }

  const checkTimeoutSeconds = Number(core.getInput("check-timeout-seconds") || 20)

  if (!(checkTimeoutSeconds > 0)) {
    throw new ConfigError(
      `check-timeout-seconds must be a positive number, got "${core.getInput("check-timeout-seconds")}"`,
    )
  }

  const token = core.getInput("github-token")
  const organization = core.getInput("organization") || (config && config.organization)

  return {
    token,
    checkContext: {
      vars: parseVars(core.getInput("vars")),
      githubUsage: token && organization ? githubUsage({ token, organization }) : undefined,
      timeoutSeconds: checkTimeoutSeconds,
      log: (message) => core.info(message),
    },
    organization,
    enterprise: core.getInput("enterprise") || (config && config.enterprise),
    pools: resolvePools({
      primaryRunner: core.getInput("primary-runner"),
      fallbackRunner: core.getInput("fallback-runner"),
      primariesRequired: core.getInput("primaries-required"),
      config,
      only: core.getInput("pools"),
    }),
    fallbackOnError: core.getBooleanInput("fallback-on-error"),
    fallbackOnForkPr: core.getBooleanInput("fallback-on-fork-pr"),
    platformCheck,
    claim: core.getBooleanInput("claim"),
    claimTtlMs: claimTtlMinutes * 60 * 1000,
  }
}

// Reads the usage once per run, however many steps check it
function githubUsage({ token, organization }) {
  let pending

  return () => {
    if (!pending) {
      pending = fetchActionsSpend({
        token,
        organization,
        baseUrl: process.env.GITHUB_API_URL || "https://api.github.com",
      }).then((spent) => {
        core.info(
          `GitHub Actions usage this month for ${organization}: $${spent.toFixed(2)} past the included minutes`,
        )

        return spent
      })
    }

    return pending
  }
}

function client({ token, organization, enterprise }) {
  if (!token) {
    throw new Error(
      'github-token is empty. Pass a GitHub App installation token (see the README section "Create a GitHub App for the token").',
    )
  }

  return new RunnerClient({
    token,
    apiPath: apiPathFor({ repository: process.env.GITHUB_REPOSITORY, organization, enterprise }),
    baseUrl: process.env.GITHUB_API_URL || "https://api.github.com",
  })
}

function writeOutputs(results) {
  const names = Object.keys(results)
  const runners = {}

  for (const name of names) runners[name] = results[name].labels

  // runs-on takes a JSON array, read with fromJson(...)
  core.setOutput("runners", JSON.stringify(runners))
  core.setOutput("details", JSON.stringify(results))
  core.setOutput(
    "claims",
    names
      .map((name) => results[name].claim)
      .filter(Boolean)
      .join(","),
  )

  if (names.length === 1) {
    const result = results[names[0]]
    core.setOutput("use-runner", JSON.stringify(result.labels))
    core.setOutput("is-primary", String(result.isPrimary))
    core.setOutput("fallback-step", String(result.fallbackStep))
    core.setOutput("runner-name", result.runnerName)
    core.setOutput("reason", result.reason)
  }

  for (const name of names) {
    const result = results[name]
    core.info(`${name}: ${JSON.stringify(result.labels)} (${result.reason})`)
  }
}

async function writeSummary(results) {
  const rows = Object.entries(results).map(([name, result]) => [
    name,
    result.labels.join(", "),
    result.isPrimary ? "primary" : `fallback ${result.fallbackStep}`,
    result.reason,
  ])

  await core.summary
    .addHeading("Runner routing", 3)
    .addTable([
      [
        { data: "Pool", header: true },
        { data: "Runs on", header: true },
        { data: "Type", header: true },
        { data: "Why", header: true },
      ],
      ...rows,
    ])
    .write()
}

async function release(claimsText) {
  const claims = parseClaims(claimsText)

  const runnerClient = client({
    token: core.getInput("github-token"),
    organization: core.getInput("organization"),
    enterprise: core.getInput("enterprise"),
  })

  for (const { runnerId, label } of claims) {
    try {
      await runnerClient.removeLabel(runnerId, label)
      core.info(`Released claim ${label} on runner ${runnerId}`)
    } catch (error) {
      // An unreleased claim only expires later, so never fail the job over it
      core.warning(`Could not release claim ${label} on runner ${runnerId}: ${error.message}`)
    }
  }
}

async function route() {
  let inputs

  try {
    inputs = readInputs()
  } catch (error) {
    core.setFailed(error.message)

    return
  }

  let results

  if (
    inputs.fallbackOnForkPr &&
    isForkPullRequest({
      eventName: process.env.GITHUB_EVENT_NAME,
      eventPath: process.env.GITHUB_EVENT_PATH,
      repository: process.env.GITHUB_REPOSITORY,
    })
  ) {
    try {
      results = await fallbackResults(
        inputs.pools,
        "pull request from a fork always uses the fallback",
        { skipSelfHosted: true, checkContext: inputs.checkContext },
      )
    } catch (error) {
      core.setFailed(error.message)

      return
    }
  } else {
    try {
      results = await routePools({
        pools: inputs.pools,
        client: client(inputs),
        claim: inputs.claim,
        claimTtlMs: inputs.claimTtlMs,
        platformCheck: inputs.platformCheck,
        runId: process.env.GITHUB_RUN_ID,
        attempt: process.env.GITHUB_RUN_ATTEMPT,
        log: (message) => core.info(message),
        warn: (message) => core.warning(message),
        checkContext: inputs.checkContext,
      })
    } catch (error) {
      if (error instanceof ConfigError || !inputs.fallbackOnError) {
        core.setFailed(error.message)

        return
      }

      core.warning("Checking for available runners failed, but fallback-on-error is true")
      core.warning(`Original error: ${error.message}`)
      results = await fallbackResults(
        inputs.pools,
        `error while checking runners: ${error.message}`,
        { checkContext: inputs.checkContext },
      )
    }
  }

  writeOutputs(results)

  try {
    await writeSummary(results)
  } catch (error) {
    core.warning(`Could not write job summary: ${error.message}`)
  }
}

async function main() {
  const claimsToRelease = core.getInput("release")

  if (claimsToRelease) {
    try {
      await release(claimsToRelease)
    } catch (error) {
      core.warning(`Could not release claims: ${error.message}`)
    }

    return
  }

  await route()
}

module.exports = { main }

if (require.main === module) {
  main()
}
