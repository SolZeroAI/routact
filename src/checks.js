const { spawn } = require('child_process');
const { ConfigError } = require('./errors');

// Conditions on a fallback step. A step's `when` is one check or a list of
// checks that must all pass:
//   "idle"                          an online, idle runner has the step's labels
//   {"idle": 2}                     at least 2 such runners
//   {"var": "NAME"}                 org/repo variable NAME is truthy (needs the vars input)
//   {"var": "NAME", "equals": "x"}  variable NAME is exactly "x"
//   {"env": "NAME"}                 environment variable NAME is truthy (same options as var)
//   {"command": "..."}              shell command exits 0, for your own logic
//   "github-minutes"                the organization's GitHub Actions usage this
//                                   month is still inside its included minutes
//   {"github-minutes": 10}          paid Actions usage this month is at most $10
//   {"not": <check>}                the inner check fails
//   {"any": [<check>, ...]}         at least one inner check passes

const FALSY = ['', '0', 'false', 'no', 'off'];
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 20;

function validate(check, where) {
  if (check === 'idle' || check === 'github-minutes') return;
  if (!check || typeof check !== 'object' || Array.isArray(check)) {
    throw new ConfigError(`${where}: unknown check ${JSON.stringify(check)}`);
  }
  const kinds = ['idle', 'var', 'env', 'command', 'github-minutes', 'not', 'any'].filter((kind) => kind in check);
  if (kinds.length !== 1) {
    throw new ConfigError(`${where}: a check needs exactly one of idle, var, env, command, github-minutes, not, any; got ${JSON.stringify(check)}`);
  }
  const maxSpend = check['github-minutes'];
  if (maxSpend !== undefined && !(typeof maxSpend === 'number' && Number.isFinite(maxSpend) && maxSpend >= 0)) {
    throw new ConfigError(`${where}: "github-minutes" needs a dollar amount of at least 0`);
  }
  if (check.not !== undefined) validate(check.not, where);
  if (check.any !== undefined) {
    if (!Array.isArray(check.any) || check.any.length === 0) throw new ConfigError(`${where}: "any" needs a list of checks`);
    check.any.forEach((inner) => validate(inner, where));
  }
  if (check.idle !== undefined && !(Number.isInteger(check.idle) && check.idle >= 1)) {
    throw new ConfigError(`${where}: "idle" needs a whole number of at least 1`);
  }
  for (const key of ['var', 'env', 'command']) {
    if (check[key] !== undefined && (typeof check[key] !== 'string' || !check[key].trim())) {
      throw new ConfigError(`${where}: "${key}" needs a non-empty string`);
    }
  }
}

function normalizeWhen(when, where) {
  if (when === undefined || when === null) return [];
  const list = Array.isArray(when) ? when : [when];
  list.forEach((check) => validate(check, where));
  return list;
}

function compareValue(value, check) {
  if (check.equals !== undefined) return String(value === undefined ? '' : value) === String(check.equals);
  return value !== undefined && value !== null && !FALSY.includes(String(value).trim().toLowerCase());
}

function describe(check) {
  if (check === 'idle') return 'idle runner';
  if (check === 'github-minutes') return 'GitHub included minutes';
  if (check['github-minutes'] !== undefined) return `GitHub paid minutes up to $${check['github-minutes']}`;
  if (check.idle !== undefined) return `${check.idle} idle runners`;
  if (check.var !== undefined) return `var ${check.var}`;
  if (check.env !== undefined) return `env ${check.env}`;
  if (check.command !== undefined) return 'command';
  if (check.not !== undefined) return `not ${describe(check.not)}`;
  return `any of ${check.any.map(describe).join(', ')}`;
}

// Runs a shell command; resolves true on exit code 0. Never rejects: a
// command that cannot start or times out counts as a failed check.
function runCommand(command, { env = {}, timeoutSeconds = DEFAULT_COMMAND_TIMEOUT_SECONDS, log = () => {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk) => { output += chunk; };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      log(`Check command timed out after ${timeoutSeconds}s`);
      child.kill('SIGKILL');
    }, timeoutSeconds * 1000);
    child.on('error', (error) => {
      clearTimeout(timer);
      log(`Check command could not start: ${error.message}`);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (output.trim()) log(output.trim());
      resolve(code === 0);
    });
  });
}

// Passes while the paid part of this month's Actions usage is at most maxSpend
// dollars. Fails when the usage cannot be read (no token, no organization,
// missing permission), so the router moves on to the next step.
async function withinGitHubMinutes(maxSpend, context) {
  const log = context.log || (() => {});
  if (!context.githubUsage) {
    log('GitHub usage is not available here (it needs an organization and a token with Administration: read)');
    return false;
  }
  let spent;
  try {
    spent = await context.githubUsage();
  } catch (error) {
    log(`Could not read GitHub usage: ${error.message}`);
    return false;
  }
  return spent <= maxSpend;
}

// context: {idleCount(labels), vars, env, commandEnv, githubUsage(), timeoutSeconds, log, run}
async function evaluate(check, step, context) {
  if (check === 'idle') return context.idleCount(step.labels) >= 1;
  if (check === 'github-minutes') return withinGitHubMinutes(0, context);
  if (check['github-minutes'] !== undefined) return withinGitHubMinutes(check['github-minutes'], context);
  if (check.idle !== undefined) return context.idleCount(step.labels) >= check.idle;
  if (check.var !== undefined) return compareValue((context.vars || {})[check.var], check);
  if (check.env !== undefined) return compareValue((context.env || process.env)[check.env], check);
  if (check.not !== undefined) return !(await evaluate(check.not, step, context));
  if (check.any !== undefined) {
    for (const inner of check.any) {
      if (await evaluate(inner, step, context)) return true;
    }
    return false;
  }
  const run = context.run || runCommand;
  return run(check.command, {
    env: { ...context.commandEnv, ROUTACT_RUNS_ON: JSON.stringify(step.labels) },
    timeoutSeconds: context.timeoutSeconds,
    log: context.log,
  });
}

// Returns {passed, failed} where failed names the first check that failed
async function evaluateAll(step, context) {
  for (const check of step.when) {
    if (!(await evaluate(check, step, context))) {
      return { passed: false, failed: describe(check) };
    }
  }
  return { passed: true };
}

function parseVars(text) {
  if (!text || !String(text).trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new ConfigError('vars must be JSON, e.g. vars: ${{ toJSON(vars) }}');
  }
}

module.exports = { normalizeWhen, evaluate, evaluateAll, describe, runCommand, parseVars };
