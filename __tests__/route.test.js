const { runner, FakeClient } = require('./helpers');
const {
  ConfigError,
  parseCount,
  decide,
  checkPlatform,
  routePools,
  claimLabel,
  parseClaims,
} = require('../src/route');

const NOW = 1_800_000_000_000;
const TTL = 10 * 60 * 1000;
const linux = ({ fallback = ['ubuntu-24.04'], ...overrides } = {}) => ({
  name: 'default',
  primary: ['self-hosted', 'Linux', 'X64'],
  fallbacks: [{ labels: fallback, when: [] }],
  primariesRequired: undefined,
  ...overrides,
});
const selfHosted = (id, options) => runner(id, ['self-hosted', 'Linux', 'X64'], options);

describe('parseCount', () => {
  it('treats an empty input as not set', () => {
    // core.getInput returns '' for unset inputs; upstream compared it to undefined
    expect(parseCount('')).toBeUndefined();
    expect(parseCount(undefined)).toBeUndefined();
  });

  it('parses numbers given as strings', () => {
    expect(parseCount('2')).toBe(2);
  });

  it('rejects nonsense', () => {
    expect(() => parseCount('0')).toThrow(ConfigError);
    expect(() => parseCount('two')).toThrow(ConfigError);
  });
});

describe('decide', () => {
  it('uses a busy primary when primaries-required is not set', () => {
    const decision = decide(linux(), [selfHosted(1, { busy: true })]);
    expect(decision.usePrimary).toBe(true);
  });

  it('falls back when not enough primaries are idle', () => {
    const decision = decide(linux({ primariesRequired: 2 }), [selfHosted(1), selfHosted(2, { busy: true })]);
    expect(decision.usePrimary).toBe(false);
    expect(decision.reason).toBe('1 of 2 online primary runners are idle, 2 required');
  });

  it('falls back when no primary is online', () => {
    const decision = decide(linux(), [selfHosted(1, { status: 'offline' })]);
    expect(decision.usePrimary).toBe(false);
  });

  it('matches labels case-insensitively', () => {
    const decision = decide(linux(), [runner(1, ['Self-Hosted', 'linux', 'x64'])]);
    expect(decision.usePrimary).toBe(true);
  });

  it('needs every primary label', () => {
    const decision = decide(linux(), [runner(1, ['self-hosted', 'Linux'])]);
    expect(decision.usePrimary).toBe(false);
  });

  it('treats a runner with a live claim as taken when claiming', () => {
    const claimed = selfHosted(1);
    claimed.labels.push({ name: `routact-claim-${NOW / 1000 - 60}-1-1-abc` });
    expect(decide(linux(), [claimed], { claim: true, now: NOW, claimTtlMs: TTL }).usePrimary).toBe(false);
    expect(decide(linux(), [claimed], { claim: false, now: NOW, claimTtlMs: TTL }).usePrimary).toBe(true);
  });
});

describe('decide with a heartbeat', () => {
  const xcode = (overrides = {}) => linux({
    name: 'xcode',
    primary: ['self-hosted', 'macOS', 'ARM64', 'xcode'],
    fallback: ['blacksmith-6vcpu-macos-26'],
    heartbeat: ['self-hosted', 'kinhin-container'],
    ...overrides,
  });
  const beat = (id, options) => runner(id, ['self-hosted', 'linux', 'ARM64', 'kinhin-container'], options);

  it('uses the primary while a heartbeat runner is online, though no primary is registered', () => {
    const decision = decide(xcode(), [beat(1)]);
    expect(decision.usePrimary).toBe(true);
    expect(decision.reason).toBe('1 heartbeat runner (self-hosted,kinhin-container) online');
  });

  it('counts a busy heartbeat runner', () => {
    expect(decide(xcode(), [beat(1, { busy: true })]).usePrimary).toBe(true);
  });

  it('falls back when no heartbeat runner is online', () => {
    const decision = decide(xcode(), [beat(1, { status: 'offline' }), selfHosted(2)]);
    expect(decision.usePrimary).toBe(false);
    expect(decision.reason).toBe('no heartbeat runner (self-hosted,kinhin-container) is online');
  });

  it('refuses to claim a runner for a heartbeat pool', async () => {
    const client = new FakeClient([beat(1)]);
    await expect(routePools({ client, claim: true, pools: [xcode({ fallback: ['self-hosted', 'macOS', 'ARM64'] })] }))
      .rejects.toThrow(/heartbeat/);
  });
});

describe('checkPlatform', () => {
  it('throws when the fallback is a different platform', () => {
    const pool = linux({ primary: ['self-hosted', 'macOS', 'ARM64'], fallback: ['ubuntu-latest'] });
    expect(() => checkPlatform(pool, [], 'error')).toThrow(/OS and architecture differ/);
  });

  it('uses the registered runner platform over its labels', () => {
    const pool = linux({ primary: ['self-hosted', 'mac-mini'], fallback: ['macos-15-intel'] });
    const mac = runner(1, ['self-hosted', 'mac-mini', 'ARM64'], { os: 'macOS' });
    expect(() => checkPlatform(pool, [mac], 'error')).toThrow(/architecture differ/);
  });

  it('only warns in warn mode', () => {
    const pool = linux({ fallback: ['ubuntu-24.04-arm'] });
    expect(checkPlatform(pool, [], 'warn')[0]).toMatch(/architecture differ/);
  });

  it('accepts a matching fallback', () => {
    expect(checkPlatform(linux(), [], 'error')).toEqual([]);
  });

  it('warns when the platform cannot be determined', () => {
    const pool = linux({ primary: ['self-hosted', 'gpu'] });
    expect(checkPlatform(pool, [], 'error')[0]).toMatch(/could not fully determine/);
  });
});

describe('routePools', () => {
  it('routes several pools with one runner list', async () => {
    const client = new FakeClient([selfHosted(1), runner(2, ['self-hosted', 'Linux', 'ARM64'], { status: 'offline' })]);
    const results = await routePools({
      client,
      now: NOW,
      pools: [
        linux({ name: 'x64' }),
        linux({ name: 'arm', primary: ['self-hosted', 'Linux', 'ARM64'], fallback: ['ubuntu-24.04-arm'] }),
      ],
    });
    expect(results.x64).toMatchObject({ labels: ['self-hosted', 'Linux', 'X64'], isPrimary: true, runnerName: 'runner-1' });
    expect(results.arm).toMatchObject({ labels: ['ubuntu-24.04-arm'], isPrimary: false });
    expect(client.calls.filter(([call]) => call === 'list')).toHaveLength(1);
  });

  it('fails on a platform mismatch before calling anything else', async () => {
    const client = new FakeClient([selfHosted(1)]);
    await expect(routePools({ client, pools: [linux({ fallback: ['macos-15'] })] })).rejects.toThrow(ConfigError);
  });

  describe('with claim', () => {
    const options = (client, extra = {}) => ({
      client,
      claim: true,
      claimTtlMs: TTL,
      now: NOW,
      runId: '42',
      attempt: '1',
      random: () => 0.5,
      pools: [linux()],
      ...extra,
    });

    it('claims an idle runner and routes to its claim label', async () => {
      const client = new FakeClient([selfHosted(1, { busy: true }), selfHosted(2)]);
      const results = await routePools(options(client));
      const label = results.default.labels[0];
      expect(label).toMatch(/^routact-claim-1800000000-42-1-/);
      expect(results.default).toMatchObject({ isPrimary: true, runnerName: 'runner-2', claim: `2:${label}` });
      expect(client.find(2).labels.map((existing) => existing.name)).toContain(label);
    });

    it('backs off when another run claims the same runner at the same time', async () => {
      const client = new FakeClient([selfHosted(1)]);
      client.afterAddLabel = (id) => client.find(id).labels.push({ name: `routact-claim-${NOW / 1000}-99-1-zzz` });
      const results = await routePools(options(client));
      expect(results.default).toMatchObject({ labels: ['ubuntu-24.04'], isPrimary: false });
      expect(results.default.reason).toMatch(/claimed by another run/);
      // Our claim is removed so the other run keeps the runner
      expect(client.find(1).labels.map((existing) => existing.name)).toEqual(
        ['self-hosted', 'Linux', 'X64', `routact-claim-${NOW / 1000}-99-1-zzz`]);
    });

    it('moves on to the next idle runner after losing a race', async () => {
      const client = new FakeClient([selfHosted(1), selfHosted(2)]);
      let raced = false;
      client.afterAddLabel = (id) => {
        if (!raced) {
          raced = true;
          client.find(id).labels.push({ name: `routact-claim-${NOW / 1000}-99-1-zzz` });
        }
      };
      const results = await routePools(options(client));
      expect(results.default.isPrimary).toBe(true);
    });

    it('removes expired claims and skips live ones', async () => {
      const stale = `routact-claim-${NOW / 1000 - 3600}-7-1-old`;
      const live = `routact-claim-${NOW / 1000 - 60}-8-1-new`;
      const client = new FakeClient([
        runner(1, ['self-hosted', 'Linux', 'X64', live]),
        runner(2, ['self-hosted', 'Linux', 'X64', stale]),
      ]);
      const results = await routePools(options(client));
      expect(client.calls).toContainEqual(['remove', 2, stale]);
      expect(results.default.runnerName).toBe('runner-2');
    });

    it('never claims the same runner for two pools in one run', async () => {
      const client = new FakeClient([selfHosted(1)]);
      const results = await routePools(options(client, { pools: [linux({ name: 'a' }), linux({ name: 'b' })] }));
      expect(results.a.isPrimary).toBe(true);
      expect(results.b.isPrimary).toBe(false);
    });
  });
});

describe('claims', () => {
  it('round-trips through parseClaims', () => {
    const label = claimLabel({ now: NOW, runId: '5', attempt: '2', random: () => 0.25 });
    expect(parseClaims(`12:${label}, 13:${label}`)).toEqual([
      { runnerId: 12, label },
      { runnerId: 13, label },
    ]);
  });

  it('rejects malformed claims', () => {
    expect(() => parseClaims('nope')).toThrow(ConfigError);
    expect(() => parseClaims('12:self-hosted')).toThrow(ConfigError);
  });
});

describe('routePools when the runner list fails', () => {
  it('still reports a platform mismatch from labels', async () => {
    const client = new FakeClient([]);
    client.listRunners = async () => { throw new Error('403'); };
    await expect(routePools({ client, pools: [linux({ fallback: ['macos-15'] })] })).rejects.toThrow(ConfigError);
    await expect(routePools({ client, pools: [linux()] })).rejects.toThrow('403');
  });
});
