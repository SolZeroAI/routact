const { RunnerClient, apiPathFor, fetchActionsSpend } = require('../src/github');

function page(count, start = 0) {
  return Array.from({ length: count }, (_, i) => ({ id: start + i }));
}

describe('RunnerClient', () => {
  it('reads every page of runners', async () => {
    const http = {
      getJson: jest.fn()
        .mockResolvedValueOnce({ statusCode: 200, result: { total_count: 130, runners: page(100) } })
        .mockResolvedValueOnce({ statusCode: 200, result: { total_count: 130, runners: page(30, 100) } }),
    };
    const client = new RunnerClient({ token: 't', apiPath: 'orgs/o/actions/runners', http });
    const runners = await client.listRunners();
    expect(runners).toHaveLength(130);
    expect(http.getJson.mock.calls[1][0]).toBe('https://api.github.com/orgs/o/actions/runners?per_page=100&page=2');
    expect(http.getJson.mock.calls[0][1]['X-GitHub-Api-Version']).toBe('2022-11-28');
  });

  it('explains permission errors', async () => {
    const error = Object.assign(new Error('Resource not accessible by integration'), { statusCode: 403 });
    const http = { getJson: jest.fn().mockRejectedValue(error) };
    const client = new RunnerClient({ token: 't', apiPath: 'orgs/o/actions/runners', http });
    await expect(client.listRunners()).rejects.toThrow(/Status code: 403. Resource not accessible.*README/);
  });

  it('treats removing a missing label as done', async () => {
    const http = { del: jest.fn().mockResolvedValue({ message: { statusCode: 404 }, readBody: async () => '' }) };
    const client = new RunnerClient({ token: 't', apiPath: 'orgs/o/actions/runners', http });
    await expect(client.removeLabel(1, 'routact-claim-1-x')).resolves.toBeUndefined();
    expect(http.del.mock.calls[0][0]).toBe('https://api.github.com/orgs/o/actions/runners/1/labels/routact-claim-1-x');
  });
});

describe('apiPathFor', () => {
  it('picks the scope', () => {
    expect(apiPathFor({ repository: 'a/b' })).toBe('repos/a/b/actions/runners');
    expect(apiPathFor({ repository: 'a/b', organization: 'o' })).toBe('orgs/o/actions/runners');
    expect(apiPathFor({ repository: 'a/b', enterprise: 'e' })).toBe('enterprises/e/actions/runners');
    expect(() => apiPathFor({ organization: 'o', enterprise: 'e' })).toThrow();
  });
});

describe('fetchActionsSpend', () => {
  it('sums the net Actions amount for the current month', async () => {
    const http = {
      getJson: jest.fn().mockResolvedValue({
        statusCode: 200,
        result: {
          usageItems: [
            { product: 'Actions', sku: 'actions_linux', netAmount: 1.5 },
            { product: 'Actions', sku: 'actions_macos', netAmount: 2 },
            { product: 'Packages', sku: 'packages_storage', netAmount: 7 },
          ],
        },
      }),
    };
    const spent = await fetchActionsSpend({ token: 't', organization: 'o', http, now: new Date(Date.UTC(2026, 9, 30)) });
    expect(spent).toBe(3.5);
    expect(http.getJson.mock.calls[0][0])
      .toBe('https://api.github.com/organizations/o/settings/billing/usage/summary?product=actions&year=2026&month=10');
    expect(http.getJson.mock.calls[0][1]['X-GitHub-Api-Version']).toBe('2026-03-10');
  });

  it('explains permission errors', async () => {
    const error = Object.assign(new Error('Resource not accessible by integration'), { statusCode: 403 });
    const http = { getJson: jest.fn().mockRejectedValue(error) };
    await expect(fetchActionsSpend({ token: 't', organization: 'o', http }))
      .rejects.toThrow(/Status code: 403.*Administration: read/);
  });
});
