// Works out the OS and CPU architecture behind a set of runner labels, so a
// fallback is only ever chosen when it matches the primary's platform.

const OS_NAMES = {
  linux: 'Linux',
  macos: 'macOS',
  windows: 'Windows',
};

const ARCH_NAMES = {
  x64: 'X64',
  arm64: 'ARM64',
  arm: 'ARM',
};

function normalize(labels) {
  return labels.map((label) => String(label).trim().toLowerCase()).filter(Boolean);
}

// GitHub-hosted labels, and common third-party ones (e.g. Blacksmith), encode
// the platform in the label name. Returns {os, arch}; either may be undefined.
function inferFromLabels(labels) {
  const names = normalize(labels);
  let os;
  let arch;

  for (const name of names) {
    // Exact runner default labels win over name heuristics
    if (OS_NAMES[name]) os = OS_NAMES[name];
    if (ARCH_NAMES[name]) arch = ARCH_NAMES[name];
  }

  for (const name of names) {
    if (!os) {
      if (/ubuntu|linux|debian|fedora|alpine/.test(name)) os = 'Linux';
      else if (/macos|osx|darwin/.test(name)) os = 'macOS';
      else if (/windows|win\d/.test(name)) os = 'Windows';
    }
    if (!arch) {
      if (/arm64|aarch64|-arm\b|arm$/.test(name)) arch = 'ARM64';
      else if (/x64|amd64|x86_64|intel/.test(name)) arch = 'X64';
    }
  }

  if (os && !arch) {
    arch = defaultArch(os, names);
  }

  return { os, arch };
}

// Hosted images without an arch in the name have a known default
function defaultArch(os, names) {
  if (os === 'macOS') {
    // macos-13 and the -large sizes are Intel, everything newer is Apple silicon
    if (names.some((name) => /^macos-13\b|-large$/.test(name))) return 'X64';
    if (names.some((name) => /^macos-/.test(name))) return 'ARM64';
    return undefined;
  }
  if (names.some((name) => /^(ubuntu|windows)-/.test(name))) return 'X64';
  return undefined;
}

// A registered runner reports its OS directly; the arch comes from its default labels
function fromRunner(runner) {
  const labels = (runner.labels || []).map((label) => label.name);
  const inferred = inferFromLabels(labels);
  // The API reports the OS in any case (kinhin runners report "linux")
  const os = runner.os ? OS_NAMES[String(runner.os).toLowerCase()] || runner.os : inferred.os;
  return { os, arch: inferred.arch };
}

function describe(platform) {
  return `${platform.os || 'unknown OS'}/${platform.arch || 'unknown arch'}`;
}

// Returns a mismatch description, or undefined when the platforms agree or
// there is not enough information to tell
function mismatch(primary, fallback) {
  const problems = [];
  if (primary.os && fallback.os && primary.os !== fallback.os) problems.push('OS');
  if (primary.arch && fallback.arch && primary.arch !== fallback.arch) problems.push('architecture');
  if (problems.length === 0) return undefined;
  return `${problems.join(' and ')} differ: primary is ${describe(primary)}, fallback is ${describe(fallback)}`;
}

function isKnown(platform) {
  return Boolean(platform.os && platform.arch);
}

module.exports = { inferFromLabels, fromRunner, mismatch, describe, isKnown };
