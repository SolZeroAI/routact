const platform = require('./platform');
const { ConfigError } = require('./errors');
const checks = require('./checks');

const CLAIM_PREFIX = 'routact-claim-';

function parseLabels(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  return list.map((label) => String(label).trim()).filter(Boolean);
}

// Empty means "not set": only online-ness matters, busy runners still count
function parseCount(value, name = 'primaries-required') {
  if (value === undefined || value === null || value === '') return undefined;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) {
    throw new ConfigError(`${name} must be a whole number of at least 1, got "${value}"`);
  }
  return count;
}

function runnerLabels(runner) {
  return (runner.labels || []).map((label) => label.name.toLowerCase());
}

// GitHub matches runs-on labels case-insensitively, so we do too
function hasLabels(runner, wanted) {
  const labels = runnerLabels(runner);
  return wanted.every((label) => labels.includes(label.toLowerCase()));
}

function claimLabel({ now, runId, attempt, random = Math.random }) {
  const suffix = random().toString(36).slice(2, 8);
  return `${CLAIM_PREFIX}${Math.floor(now / 1000)}-${runId || 'local'}-${attempt || 1}-${suffix}`;
}

function claimTime(label) {
  const match = new RegExp(`^${CLAIM_PREFIX}(\\d+)-`).exec(label);
  return match ? Number(match[1]) * 1000 : undefined;
}

function claims(runner) {
  return runnerLabels(runner).filter((label) => label.startsWith(CLAIM_PREFIX));
}

function liveClaims(runner, now, ttlMs) {
  return claims(runner).filter((label) => {
    const time = claimTime(label);
    return time !== undefined && now - time < ttlMs;
  });
}

function staleClaims(runner, now, ttlMs) {
  const live = liveClaims(runner, now, ttlMs);
  return claims(runner).filter((label) => !live.includes(label));
}

// Platform of the primary: from a registered runner if any match, else from its labels
function primaryPlatform(pool, runners) {
  const registered = runners.find((runner) => hasLabels(runner, pool.primary));
  return registered ? platform.fromRunner(registered) : platform.inferFromLabels(pool.primary);
}

// A fallback can itself be a self-hosted label set, so prefer a registered runner
function stepPlatform(labels, runners) {
  const registered = runners.find((runner) => hasLabels(runner, labels));
  return registered ? platform.fromRunner(registered) : platform.inferFromLabels(labels);
}

// Checks every fallback step against the primary. Returns a list of warnings;
// throws ConfigError when the policy is "error".
function checkPlatform(pool, runners, policy) {
  if (policy === 'off') return [];
  const primary = primaryPlatform(pool, runners);
  const warnings = [];
  pool.fallbacks.forEach((step, index) => {
    const name = pool.fallbacks.length > 1 ? `fallback step ${index + 1} (${step.labels.join(',')})` : 'fallback runner';
    const fallback = stepPlatform(step.labels, runners);
    const problem = platform.mismatch(primary, fallback);
    if (problem) {
      const message = `Pool "${pool.name}": ${name} does not match the primary platform (${problem}).`;
      if (policy === 'error') {
        throw new ConfigError(`${message} Pick a fallback with the same OS and architecture, or set platform-check to "warn" or "off".`);
      }
      warnings.push(message);
    } else if (!platform.isKnown(primary) || !platform.isKnown(fallback)) {
      warnings.push(`Pool "${pool.name}": could not fully determine the platform (primary ${platform.describe(primary)}, ${name} ${platform.describe(fallback)}), so the platform check is incomplete. Add OS and architecture labels such as Linux,X64 to make it exact.`);
    }
  });
  return warnings;
}

function isSelfHosted(labels) {
  return labels.some((label) => label.toLowerCase() === 'self-hosted');
}

// Walks the fallback steps in order and returns the first whose checks pass.
// When none pass, the last eligible step is used so a job always has a runner.
async function chooseFallback(pool, { runners, skipSelfHosted = false, checkContext = {} }) {
  const idleCount = (labels) => runners.filter((runner) => runner.status === 'online'
    && runner.busy !== true && hasLabels(runner, labels)).length;
  const context = {
    ...checkContext,
    idleCount,
    commandEnv: { ...checkContext.commandEnv, ROUTACT_POOL: pool.name },
  };
  const skipped = [];
  const eligible = pool.fallbacks
    .map((step, index) => ({ step, index }))
    .filter(({ step, index }) => {
      if (skipSelfHosted && isSelfHosted(step.labels)) {
        skipped.push(`step ${index + 1} is self-hosted`);
        return false;
      }
      return true;
    });

  for (const { step, index } of eligible) {
    const outcome = await checks.evaluateAll(step, context);
    if (outcome.passed) return { step, index, skipped };
    skipped.push(`step ${index + 1} check "${outcome.failed}" failed`);
  }

  const last = eligible.length > 0 ? eligible[eligible.length - 1] : { step: pool.fallbacks[pool.fallbacks.length - 1], index: pool.fallbacks.length - 1 };
  return { ...last, skipped, exhausted: pool.fallbacks.length > 1 || last.step.when.length > 0 };
}

function describeFallback(pool, choice) {
  const parts = [];
  if (pool.fallbacks.length > 1) parts.push(`fallback step ${choice.index + 1}`);
  if (choice.skipped.length > 0) parts.push(`after ${choice.skipped.join(', ')}`);
  if (choice.exhausted) parts.push('no step passed its checks, using the last one');
  return parts.join(', ');
}

async function fallbackResult(pool, reason, options) {
  const choice = await chooseFallback(pool, options);
  const detail = describeFallback(pool, choice);
  return {
    labels: choice.step.labels,
    isPrimary: false,
    fallbackStep: choice.index + 1,
    runnerName: '',
    claim: '',
    reason: detail ? `${reason}; ${detail}` : reason,
  };
}

// Pure decision for one pool given the current runner list
function decide(pool, runners, { claim = false, now = Date.now(), claimTtlMs } = {}) {
  const matching = runners.filter((runner) => runner.status === 'online' && hasLabels(runner, pool.primary));
  const idle = matching.filter((runner) => runner.busy !== true
    && (!claim || liveClaims(runner, now, claimTtlMs).length === 0));
  // Claiming always needs at least one idle runner to claim
  const required = pool.primariesRequired !== undefined ? pool.primariesRequired : (claim ? 1 : undefined);

  if (matching.length === 0) {
    return { usePrimary: false, matching, idle, reason: 'no matching primary runner is online' };
  }
  if (required !== undefined && idle.length < required) {
    return {
      usePrimary: false,
      matching,
      idle,
      reason: `${idle.length} of ${matching.length} online primary runners are idle, ${required} required`,
    };
  }
  const reason = required === undefined
    ? `${matching.length} primary runners online`
    : `${idle.length} of ${matching.length} online primary runners are idle, ${required} required`;
  return { usePrimary: true, matching, idle, reason };
}

function shuffle(list, random = Math.random) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Labels one idle runner with a claim that only this run holds. A claim wins
// only when it is the sole live claim on the runner after it was written, so
// two routers racing for the same runner can both lose (and try the next one)
// but can never both win.
async function claimRunner({ client, candidates, label, now, claimTtlMs, random, log = () => {} }) {
  for (const candidate of shuffle(candidates, random)) {
    await client.addLabel(candidate.id, label);
    let fresh;
    try {
      fresh = await client.getRunner(candidate.id);
    } catch (error) {
      log(`Could not re-read runner ${candidate.name} after claiming it: ${error.message}`);
      await releaseQuietly(client, candidate.id, label, log);
      continue;
    }
    const live = liveClaims(fresh, now, claimTtlMs);
    const ours = live.includes(label.toLowerCase());
    if (ours && live.length === 1 && fresh.status === 'online' && fresh.busy !== true) {
      return fresh;
    }
    log(`Runner ${candidate.name} was taken by another run, trying the next one`);
    await releaseQuietly(client, candidate.id, label, log);
  }
  return undefined;
}

async function releaseQuietly(client, runnerId, label, log) {
  try {
    await client.removeLabel(runnerId, label);
  } catch (error) {
    log(`Could not remove claim ${label} from runner ${runnerId}: ${error.message}`);
  }
}

// Expired claims are left behind when a job never ran its release step
async function removeStaleClaims({ client, runners, now, claimTtlMs, log = () => {} }) {
  for (const runner of runners) {
    for (const label of staleClaims(runner, now, claimTtlMs)) {
      log(`Removing expired claim ${label} from runner ${runner.name}`);
      await releaseQuietly(client, runner.id, label, log);
    }
  }
}

function formatClaim(runnerId, label) {
  return `${runnerId}:${label}`;
}

function parseClaims(value) {
  return String(value || '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((entry) => {
      const index = entry.indexOf(':');
      const runnerId = Number(entry.slice(0, index));
      const label = entry.slice(index + 1);
      if (index < 1 || !Number.isInteger(runnerId) || !label.startsWith(CLAIM_PREFIX)) {
        throw new ConfigError(`Invalid claim "${entry}", expected <runner-id>:${CLAIM_PREFIX}...`);
      }
      return { runnerId, label };
    });
}

// Routes every pool against one runner list. Returns {pool name: result}.
async function routePools({
  pools,
  client,
  claim = false,
  claimTtlMs = 10 * 60 * 1000,
  platformCheck = 'error',
  runId,
  attempt,
  now = Date.now(),
  random = Math.random,
  log = () => {},
  warn = () => {},
  checkContext = {},
}) {
  let runners;
  try {
    runners = await client.listRunners();
  } catch (error) {
    // Still catch a cross-platform fallback from the labels alone, so a broken
    // config is not hidden behind fallback-on-error
    for (const pool of pools) checkPlatform(pool, [], platformCheck);
    throw error;
  }

  for (const pool of pools) {
    checkPlatform(pool, runners, platformCheck).forEach((message) => warn(message));
  }

  if (claim) {
    await removeStaleClaims({ client, runners, now, claimTtlMs, log });
  }

  const results = {};
  const claimedIds = new Set();
  for (const pool of pools) {
    const available = runners.filter((runner) => !claimedIds.has(runner.id));
    const decision = decide(pool, available, { claim, now, claimTtlMs });

    if (!decision.usePrimary) {
      results[pool.name] = await fallbackResult(pool, decision.reason, { runners: available, checkContext });
      continue;
    }

    const result = {
      labels: pool.primary,
      isPrimary: true,
      fallbackStep: 0,
      runnerName: decision.matching.length === 1 ? decision.matching[0].name : '',
      claim: '',
      reason: decision.reason,
    };

    if (claim) {
      const label = claimLabel({ now, runId, attempt, random });
      const won = await claimRunner({ client, candidates: decision.idle, label, now, claimTtlMs, random, log });
      if (!won) {
        results[pool.name] = await fallbackResult(pool,
          `${decision.reason}, but every idle runner was claimed by another run first`, { runners: available, checkContext });
        continue;
      }
      claimedIds.add(won.id);
      result.labels = [label];
      result.runnerName = won.name;
      result.claim = formatClaim(won.id, label);
      result.reason = `${decision.reason}; claimed runner ${won.name}`;
    }

    results[pool.name] = result;
  }
  return results;
}

// Routes without looking at runners: for fork pull requests and API errors.
// Checks that need the runner list (idle) fail; fork PRs skip self-hosted steps.
async function fallbackResults(pools, reason, { skipSelfHosted = false, checkContext = {} } = {}) {
  const results = {};
  for (const pool of pools) {
    results[pool.name] = await fallbackResult(pool, reason, { runners: [], skipSelfHosted, checkContext });
  }
  return results;
}

module.exports = {
  CLAIM_PREFIX,
  ConfigError,
  chooseFallback,
  parseLabels,
  parseCount,
  hasLabels,
  claimLabel,
  claimTime,
  liveClaims,
  staleClaims,
  checkPlatform,
  decide,
  claimRunner,
  removeStaleClaims,
  formatClaim,
  parseClaims,
  routePools,
  fallbackResults,
};
