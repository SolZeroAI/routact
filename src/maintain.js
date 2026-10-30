const { ConfigError } = require('./errors');
const { parseConfig } = require('./config');
const { hasLabels, checkPlatform } = require('./route');
const images = require('./images');
const checks = require('./checks');

const TASKS = ['validate', 'images', 'flags'];

function parseTasks(text) {
  const tasks = String(text || TASKS.join(',')).split(',').map((task) => task.trim().toLowerCase()).filter(Boolean);
  const unknown = tasks.filter((task) => !TASKS.includes(task));
  if (unknown.length > 0) throw new ConfigError(`Unknown maintenance tasks: ${unknown.join(', ')} (known: ${TASKS.join(', ')})`);
  return tasks;
}

// Flags map an org variable to a check that runs on schedule. The variable is
// set to "true" when the check passes, "false" otherwise, for "var" checks to
// read. A flag is a shell command (exit 0 passes), or a built-in check:
//   {"VARIABLE": "command"}
//   {"VARIABLE": {"command": "..."}}
//   {"VARIABLE": {"blacksmith": {"budget-usd": 250}}}
function parseFlags(text) {
  if (!text || !String(text).trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`flags is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError('flags must be a JSON object of variable name to command');
  }
  return Object.entries(parsed).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new ConfigError(`flags: "${name}" is not a valid variable name`);
    if (value && typeof value === 'object' && value.blacksmith !== undefined) {
      return { name, blacksmith: parseBlacksmith(value.blacksmith, `flags: "${name}"`) };
    }
    const command = typeof value === 'string' ? value : value && value.command;
    if (typeof command !== 'string' || !command.trim()) throw new ConfigError(`flags: "${name}" needs a command`);
    return { name, command };
  });
}

const BLACKSMITH_LIMITS = [
  { key: 'budget-usd', field: 'cost_usd', unit: '$' },
  { key: 'max-billing-minutes', field: 'billing_minutes', unit: ' billing minutes' },
];

// Built-in Blacksmith check: passes while this calendar month's (UTC) usage is
// below every limit given. Options:
//   budget-usd           limit on summary.cost_usd
//   max-billing-minutes  limit on summary.billing_minutes
//   organization         Blacksmith organization slug (default: the GitHub org)
function parseBlacksmith(spec, where) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new ConfigError(`${where}: "blacksmith" needs an object such as {"budget-usd": 250}`);
  }
  const limits = [];
  for (const { key, field, unit } of BLACKSMITH_LIMITS) {
    if (spec[key] === undefined) continue;
    if (typeof spec[key] !== 'number' || !(spec[key] >= 0)) throw new ConfigError(`${where}: "${key}" needs a number of at least 0`);
    limits.push({ key, field, unit, limit: spec[key] });
  }
  if (limits.length === 0) throw new ConfigError(`${where}: "blacksmith" needs "budget-usd" or "max-billing-minutes"`);
  if (spec.organization !== undefined && (typeof spec.organization !== 'string' || !/^[\w.-]+$/.test(spec.organization))) {
    throw new ConfigError(`${where}: "organization" must be a Blacksmith organization slug`);
  }
  return { limits, organization: spec.organization };
}

// Prints this month's usage as JSON. Downloads the CLI binary with its checksum
// instead of running the installer, which also installs rsync, and signs in
// with the BLACKSMITH_API_TOKEN environment variable (an organization token).
function blacksmithUsageScript(organization) {
  const org = organization || '$ROUTACT_ORGANIZATION';
  return `set -euo pipefail
if [ -z "\${BLACKSMITH_API_TOKEN:-}" ]; then echo "BLACKSMITH_API_TOKEN is not set" >&2; exit 2; fi
dir="$(mktemp -d)"; cd "$dir"; export HOME="$dir"
case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; *) echo "Unsupported architecture" >&2; exit 2 ;; esac
url="https://clireleases.blacksmith.sh/cli/latest/$(uname -s | tr '[:upper:]' '[:lower:]')/$arch/blacksmith"
curl -fsSL "$url" -o blacksmith
curl -fsSL "$url.sha256" -o blacksmith.sha256
[ "$(awk '{print $1}' blacksmith.sha256)" = "$(sha256sum blacksmith | awk '{print $1}')" ] || { echo "Blacksmith CLI checksum mismatch" >&2; exit 2; }
chmod +x blacksmith
printf '%s' "$BLACKSMITH_API_TOKEN" | ./blacksmith auth login --api-token - --non-interactive --organization "${org}" >&2
./blacksmith usage --start-time "$(date -u +%Y-%m-01T00:00:00Z)" --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)"`;
}

// Returns true while usage is below every limit
function withinBlacksmithLimits(usage, limits, log) {
  const summary = (usage && usage.summary) || {};
  let within = true;
  for (const { key, field, unit, limit } of limits) {
    const value = Number(summary[field]);
    if (!Number.isFinite(value)) throw new Error(`Blacksmith usage has no summary.${field}`);
    const shown = unit === '$' ? `$${value.toFixed(2)} of $${limit}` : `${value} of ${limit}${unit}`;
    log(`Blacksmith this month: ${shown} (${key})`);
    if (value >= limit) within = false;
  }
  return within;
}

async function blacksmithFlag(flag, { exec, commandEnv, timeoutSeconds, log }) {
  const result = await exec(blacksmithUsageScript(flag.blacksmith.organization), { env: commandEnv, timeoutSeconds, log, quiet: true });
  if (!result.ok) throw new Error(`Could not read Blacksmith usage for ${flag.name}`);
  let usage;
  try {
    usage = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Blacksmith usage for ${flag.name} was not JSON`);
  }
  return withinBlacksmithLimits(usage, flag.blacksmith.limits, log);
}

function varNames(check) {
  if (!check || typeof check !== 'object') return [];
  if (check.var !== undefined) return [check.var];
  if (check.not !== undefined) return varNames(check.not);
  if (check.any !== undefined) return check.any.flatMap(varNames);
  return [];
}

function countMatching(runners, labels) {
  const matching = runners.filter((runner) => hasLabels(runner, labels));
  return { registered: matching.length, online: matching.filter((runner) => runner.status === 'online').length };
}

function isSelfHosted(labels) {
  return labels.some((label) => label.toLowerCase() === 'self-hosted');
}

// Checks the config against the registered runners and the variables it reads
function validate({ config, runners, vars }) {
  const errors = [];
  const warnings = [];
  for (const pool of config.pools) {
    try {
      checkPlatform(pool, runners, 'error').forEach((message) => warnings.push(message));
    } catch (error) {
      errors.push(error.message);
    }

    const primary = countMatching(runners, pool.primary);
    if (primary.registered === 0) {
      warnings.push(`Pool "${pool.name}": no registered runner has all the primary labels ${pool.primary.join(',')}, so it always falls back.`);
    } else if (primary.online === 0) {
      warnings.push(`Pool "${pool.name}": all ${primary.registered} primary runners are offline.`);
    }

    pool.fallbacks.forEach((step, index) => {
      const where = `Pool "${pool.name}" fallback step ${index + 1} (${step.labels.join(',')})`;
      if (isSelfHosted(step.labels) && countMatching(runners, step.labels).registered === 0) {
        warnings.push(`${where}: no registered runner has these labels.`);
      }
      for (const name of step.when.flatMap(varNames)) {
        if (vars[name] === undefined) {
          warnings.push(`${where}: checks the variable ${name}, which is not set, so the step is never used.`);
        }
      }
    });
  }
  return { errors, warnings };
}

// Flags retired, deprecated and pre-release GitHub-hosted labels, and suggests
// the newest generally available label of the same kind
function reviewImages({ config, imageList }) {
  const errors = [];
  const warnings = [];
  const upgrades = {};
  for (const pool of config.pools) {
    pool.fallbacks.forEach((step, index) => {
      const where = `Pool "${pool.name}" fallback step ${index + 1}`;
      for (const label of step.labels.filter(images.isHostedLabel)) {
        const image = images.findImage(imageList, label);
        const newer = images.newerLabel(imageList, label);
        if (!image) {
          errors.push(`${where}: "${label}" is not a current GitHub-hosted label (retired or misspelled)${newer ? `; use "${newer}"` : ''}.`);
        } else if (image.status === 'deprecated') {
          errors.push(`${where}: "${label}" is deprecated and will stop working${newer ? `; use "${newer}"` : ''}.`);
        } else if (image.status !== 'ga') {
          warnings.push(`${where}: "${label}" is a ${image.status} image, without GitHub's SLA.`);
        }
        if (newer) upgrades[label.toLowerCase()] = newer;
      }
    });
  }
  return { errors, warnings, upgrades };
}

function replaceLabels(value, upgrades) {
  if (Array.isArray(value)) return value.map((label) => replaceLabels(label, upgrades));
  if (typeof value !== 'string') return value;
  return value.split(',').map((label) => upgrades[label.trim().toLowerCase()] || label.trim()).join(',');
}

// The raw config with every upgradable fallback label replaced, keeping its shape
function upgradeConfig(raw, upgrades) {
  const copy = JSON.parse(JSON.stringify(raw));
  const pools = copy.pools || copy;
  for (const [name, pool] of Object.entries(pools)) {
    if (['organization', 'enterprise'].includes(name) || !pool || typeof pool !== 'object') continue;
    if (Array.isArray(pool.fallback) && pool.fallback.some((step) => step && typeof step === 'object')) {
      pool.fallback = pool.fallback.map((step) => ({ ...step, 'runs-on': replaceLabels(step['runs-on'], upgrades) }));
    } else {
      pool.fallback = replaceLabels(pool.fallback, upgrades);
    }
  }
  return copy;
}

// Returns {results, errors}. A flag whose check or update fails is left as it
// was, so a network blip never flips a variable.
async function updateFlags({ flags, vars, run, exec, setVariable, commandEnv, timeoutSeconds, log }) {
  const results = [];
  const errors = [];
  for (const flag of flags) {
    try {
      const passed = flag.blacksmith
        ? await blacksmithFlag(flag, { exec, commandEnv, timeoutSeconds, log })
        : await run(flag.command, { env: commandEnv, timeoutSeconds, log });
      const value = passed ? 'true' : 'false';
      const changed = vars[flag.name] !== value;
      if (changed) await setVariable(flag.name, value);
      results.push({ name: flag.name, value, changed });
    } catch (error) {
      errors.push(`Flag ${flag.name} not updated: ${error.message}`);
    }
  }
  return { results, errors };
}

async function maintain({
  configText,
  tasks = TASKS,
  client,
  vars = {},
  flags = [],
  loadImages = images.fetchImages,
  run = checks.runCommand,
  exec = checks.execCommand,
  setVariable,
  applyUpgrades = false,
  commandEnv = {},
  timeoutSeconds = 60,
  log = () => {},
}) {
  const report = { errors: [], warnings: [], upgrades: {}, suggestedConfig: undefined, flags: [], applied: false };

  if (tasks.includes('flags') && flags.length > 0) {
    const { results, errors } = await updateFlags({ flags, vars, run, exec, setVariable, commandEnv, timeoutSeconds, log });
    report.flags = results;
    report.errors.push(...errors);
    // Later checks read the updated values
    for (const flag of results) vars = { ...vars, [flag.name]: flag.value };
  }

  const wantsConfig = tasks.includes('validate') || tasks.includes('images');
  if (!wantsConfig) return report;

  let config;
  let raw;
  try {
    config = parseConfig(configText);
    raw = JSON.parse(configText);
  } catch (error) {
    report.errors.push(`ROUTACT_CONFIG is invalid: ${error.message}`);
    return report;
  }
  if (!config) {
    report.errors.push('ROUTACT_CONFIG is empty.');
    return report;
  }

  if (tasks.includes('validate')) {
    try {
      const runners = await client.listRunners();
      const result = validate({ config, runners, vars });
      report.errors.push(...result.errors);
      report.warnings.push(...result.warnings);
    } catch (error) {
      report.errors.push(`Could not list runners: ${error.message}`);
    }
  }

  if (tasks.includes('images')) {
    try {
      const result = reviewImages({ config, imageList: await loadImages() });
      report.errors.push(...result.errors);
      report.warnings.push(...result.warnings);
      report.upgrades = result.upgrades;
      if (Object.keys(result.upgrades).length > 0) {
        report.suggestedConfig = JSON.stringify(upgradeConfig(raw, result.upgrades), null, 2);
        if (applyUpgrades) {
          await setVariable('ROUTACT_CONFIG', JSON.stringify(upgradeConfig(raw, result.upgrades)));
          report.applied = true;
        }
      }
    } catch (error) {
      report.warnings.push(`Could not check GitHub-hosted images: ${error.message}`);
    }
  }

  return report;
}

module.exports = { TASKS, parseTasks, parseFlags, blacksmithUsageScript, withinBlacksmithLimits, validate, reviewImages, upgradeConfig, maintain };
