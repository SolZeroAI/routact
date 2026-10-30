const { inferFromLabels, fromRunner, mismatch } = require('../src/platform');

describe('inferFromLabels', () => {
  it.each([
    [['ubuntu-latest'], 'Linux', 'X64'],
    [['ubuntu-24.04'], 'Linux', 'X64'],
    [['ubuntu-slim'], 'Linux', 'X64'],
    [['ubuntu-24.04-arm'], 'Linux', 'ARM64'],
    [['windows-latest'], 'Windows', 'X64'],
    [['windows-11-arm'], 'Windows', 'ARM64'],
    [['macos-15'], 'macOS', 'ARM64'],
    [['macos-latest'], 'macOS', 'ARM64'],
    [['macos-15-xlarge'], 'macOS', 'ARM64'],
    [['macos-15-large'], 'macOS', 'X64'],
    [['macos-15-intel'], 'macOS', 'X64'],
    [['macos-13'], 'macOS', 'X64'],
    [['self-hosted', 'Linux', 'ARM64'], 'Linux', 'ARM64'],
    [['self-hosted', 'macOS', 'X64'], 'macOS', 'X64'],
    [['blacksmith-4vcpu-ubuntu-2404-arm'], 'Linux', 'ARM64'],
  ])('%j is %s/%s', (labels, os, arch) => {
    expect(inferFromLabels(labels)).toEqual({ os, arch });
  });

  it('leaves unknowns undefined', () => {
    expect(inferFromLabels(['self-hosted', 'gpu'])).toEqual({ os: undefined, arch: undefined });
    expect(inferFromLabels(['blacksmith-4vcpu-ubuntu-2404'])).toEqual({ os: 'Linux', arch: undefined });
  });
});

describe('fromRunner', () => {
  it('uses the reported os and the arch label', () => {
    const runner = { os: 'macOS', labels: [{ name: 'self-hosted' }, { name: 'ARM64' }, { name: 'mac-mini' }] };
    expect(fromRunner(runner)).toEqual({ os: 'macOS', arch: 'ARM64' });
  });

  it('normalizes the case of the reported os', () => {
    const linux = { os: 'linux', labels: [{ name: 'self-hosted' }, { name: 'arm64' }, { name: 'linux' }] };
    expect(fromRunner(linux)).toEqual({ os: 'Linux', arch: 'ARM64' });
    const mac = { os: 'macos', labels: [{ name: 'self-hosted' }, { name: 'arm64' }] };
    expect(fromRunner(mac)).toEqual({ os: 'macOS', arch: 'ARM64' });
  });
});

describe('mismatch', () => {
  it('reports OS and arch differences', () => {
    expect(mismatch({ os: 'macOS', arch: 'ARM64' }, { os: 'Linux', arch: 'X64' })).toMatch(/OS and architecture differ/);
    expect(mismatch({ os: 'Linux', arch: 'ARM64' }, { os: 'Linux', arch: 'X64' })).toMatch(/^architecture differ/);
  });

  it('ignores unknowns', () => {
    expect(mismatch({ os: 'Linux', arch: undefined }, { os: 'Linux', arch: 'X64' })).toBeUndefined();
  });
});
