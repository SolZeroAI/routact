const { ConfigError, parseLabels, parseCount } = require('./route');

const DEFAULT_POOL = 'default';

// Shared rules, usually stored as JSON in an org variable such as vars.ROUTACT_CONFIG:
// {
//   "organization": "my-org",
//   "pools": {
//     "linux-arm": { "primary": "self-hosted,Linux,ARM64", "fallback": "ubuntu-24.04-arm", "primaries-required": 1 }
//   }
// }
// A bare object of pools (without the "pools" key) is accepted too.
function parseConfig(text) {
  if (!text || !String(text).trim()) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`config is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError('config must be a JSON object');
  }

  const poolsObject = parsed.pools || omit(parsed, ['organization', 'enterprise']);
  const pools = Object.entries(poolsObject).map(([name, value]) => parsePool(name, value));
  if (pools.length === 0) {
    throw new ConfigError('config does not define any pools');
  }
  return {
    organization: parsed.organization,
    enterprise: parsed.enterprise,
    pools,
  };
}

function parsePool(name, value) {
  if (!value || typeof value !== 'object') {
    throw new ConfigError(`Pool "${name}" must be an object with "primary" and "fallback"`);
  }
  const pool = {
    name,
    primary: parseLabels(value.primary),
    fallback: parseLabels(value.fallback),
    primariesRequired: parseCount(value['primaries-required'], `Pool "${name}" primaries-required`),
  };
  if (pool.primary.length === 0) throw new ConfigError(`Pool "${name}" has no primary labels`);
  if (pool.fallback.length === 0) throw new ConfigError(`Pool "${name}" has no fallback labels`);
  return pool;
}

function omit(object, keys) {
  return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
}

// Pools from the single-pool inputs (primary-runner / fallback-runner) or from config.
// `only` limits config pools to the named ones.
function resolvePools({ primaryRunner, fallbackRunner, primariesRequired, config, only }) {
  if (primaryRunner || fallbackRunner) {
    if (!primaryRunner || !fallbackRunner) {
      throw new ConfigError('primary-runner and fallback-runner must be set together');
    }
    return [{
      name: DEFAULT_POOL,
      primary: parseLabels(primaryRunner),
      fallback: parseLabels(fallbackRunner),
      primariesRequired: parseCount(primariesRequired),
    }];
  }
  if (!config) {
    throw new ConfigError('Set either primary-runner and fallback-runner, or config');
  }
  const wanted = parseLabels(only);
  if (wanted.length === 0) return config.pools;
  return wanted.map((name) => {
    const pool = config.pools.find((candidate) => candidate.name === name);
    if (!pool) {
      const known = config.pools.map((candidate) => candidate.name).join(', ');
      throw new ConfigError(`Pool "${name}" is not in config (known pools: ${known})`);
    }
    return pool;
  });
}

module.exports = { DEFAULT_POOL, parseConfig, resolvePools };
