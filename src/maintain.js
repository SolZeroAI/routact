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

// Flags: {"VARIABLE": "command"} or {"VARIABLE": {"command": "..."}}. Each
// command runs on schedule and sets the org variable to "true" when it exits 0,
// "false" otherwise, for "var" checks to read.
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
    const command = typeof value === 'string' ? value : value && value.command;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new ConfigError(`flags: "${name}" is not a valid variable name`);
    if (typeof command !== 'string' || !command.trim()) throw new ConfigError(`flags: "${name}" needs a command`);
    return { name, command };
  });
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

async function updateFlags({ flags, vars, run, setVariable, commandEnv, timeoutSeconds, log }) {
  const results = [];
  for (const flag of flags) {
    const passed = await run(flag.command, { env: commandEnv, timeoutSeconds, log });
    const value = passed ? 'true' : 'false';
    const changed = vars[flag.name] !== value;
    if (changed) await setVariable(flag.name, value);
    results.push({ name: flag.name, value, changed });
  }
  return results;
}

async function maintain({
  configText,
  tasks = TASKS,
  client,
  vars = {},
  flags = [],
  loadImages = images.fetchImages,
  run = checks.runCommand,
  setVariable,
  applyUpgrades = false,
  commandEnv = {},
  timeoutSeconds = 60,
  log = () => {},
}) {
  const report = { errors: [], warnings: [], upgrades: {}, suggestedConfig: undefined, flags: [], applied: false };

  if (tasks.includes('flags') && flags.length > 0) {
    try {
      report.flags = await updateFlags({ flags, vars, run, setVariable, commandEnv, timeoutSeconds, log });
      // Later checks read the updated values
      for (const flag of report.flags) vars = { ...vars, [flag.name]: flag.value };
    } catch (error) {
      report.errors.push(`Updating flags failed: ${error.message}`);
    }
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

module.exports = { TASKS, parseTasks, parseFlags, validate, reviewImages, upgradeConfig, maintain };
