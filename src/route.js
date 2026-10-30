const platform = require('./platform');

const CLAIM_PREFIX = 'routact-claim-';

// Errors in the routing setup itself. These fail the job even with
// fallback-on-error, because falling back would hide a broken configuration.
class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

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

// The fallback can itself be a self-hosted label set, so prefer a registered runner
function fallbackPlatform(pool, runners) {
  const registered = runners.find((runner) => hasLabels(runner, pool.fallback));
  return registered ? platform.fromRunner(registered) : platform.inferFromLabels(pool.fallback);
}

// Returns a list of warnings; throws ConfigError when the policy is "error"
function checkPlatform(pool, runners, policy) {
  if (policy === 'off') return [];
  const primary = primaryPlatform(pool, runners);
  const fallback = fallbackPlatform(pool, runners);
  const problem = platform.mismatch(primary, fallback);
  if (problem) {
    const message = `Pool "${pool.name}": fallback runner does not match the primary platform (${problem}).`;
    if (policy === 'error') {
      throw new ConfigError(`${message} Pick a fallback with the same OS and architecture, or set platform-check to "warn" or "off".`);
    }
    return [message];
  }
  if (!platform.isKnown(primary) || !platform.isKnown(fallback)) {
    return [`Pool "${pool.name}": could not fully determine the platform (primary ${platform.describe(primary)}, fallback ${platform.describe(fallback)}), so the platform check is incomplete. Add OS and architecture labels such as Linux,X64 to make it exact.`];
  }
  return [];
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
    const result = {
      labels: decision.usePrimary ? pool.primary : pool.fallback,
      isPrimary: decision.usePrimary,
      runnerName: '',
      claim: '',
      reason: decision.reason,
    };

    if (decision.usePrimary && claim) {
      const label = claimLabel({ now, runId, attempt, random });
      const won = await claimRunner({ client, candidates: decision.idle, label, now, claimTtlMs, random, log });
      if (won) {
        claimedIds.add(won.id);
        result.labels = [label];
        result.runnerName = won.name;
        result.claim = formatClaim(won.id, label);
        result.reason = `${decision.reason}; claimed runner ${won.name}`;
      } else {
        result.labels = pool.fallback;
        result.isPrimary = false;
        result.reason = `${decision.reason}, but every idle runner was claimed by another run first`;
      }
    } else if (decision.usePrimary && decision.matching.length === 1) {
      result.runnerName = decision.matching[0].name;
    }

    results[pool.name] = result;
  }
  return results;
}

function fallbackResults(pools, reason) {
  const results = {};
  for (const pool of pools) {
    results[pool.name] = { labels: pool.fallback, isPrimary: false, runnerName: '', claim: '', reason };
  }
  return results;
}

module.exports = {
  CLAIM_PREFIX,
  ConfigError,
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
