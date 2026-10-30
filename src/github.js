const httpClient = require('@actions/http-client');

const API_VERSION = '2022-11-28';
const PAGE_SIZE = 100;

// Thin client for the self-hosted runner endpoints. apiPath is one of
// repos/{owner}/{repo}/actions/runners, orgs/{org}/actions/runners or
// enterprises/{enterprise}/actions/runners.
class RunnerClient {
  constructor({ token, apiPath, baseUrl = 'https://api.github.com', http }) {
    this.apiPath = apiPath;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.http = http || new httpClient.HttpClient('routact', [], {
      allowRetries: true,
      maxRetries: 3,
      socketTimeout: 15000,
    });
    this.headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
    };
  }

  url(path = '') {
    return `${this.baseUrl}/${this.apiPath}${path}`;
  }

  // getJson/postJson reject on most non-2xx codes and resolve on 404; send
  // both through assertOk so every failure carries the same hint
  async request(action, fn) {
    let response;
    try {
      response = await fn();
    } catch (error) {
      response = { statusCode: error.statusCode, error };
    }
    assertOk(response, action);
    return response;
  }

  async listRunners() {
    const runners = [];
    for (let page = 1; ; page++) {
      const response = await this.request('list runners',
        () => this.http.getJson(this.url(`?per_page=${PAGE_SIZE}&page=${page}`), this.headers));
      const batch = (response.result && response.result.runners) || [];
      runners.push(...batch);
      const total = response.result && response.result.total_count;
      if (batch.length < PAGE_SIZE || (total !== undefined && runners.length >= total)) {
        return runners;
      }
    }
  }

  async getRunner(id) {
    const response = await this.request(`get runner ${id}`,
      () => this.http.getJson(this.url(`/${id}`), this.headers));
    return response.result;
  }

  async addLabel(id, label) {
    await this.request(`add label to runner ${id}`,
      () => this.http.postJson(this.url(`/${id}/labels`), { labels: [label] }, this.headers));
  }

  async removeLabel(id, label) {
    const response = await this.http.del(this.url(`/${id}/labels/${encodeURIComponent(label)}`), this.headers);
    const statusCode = response.message.statusCode;
    await response.readBody();
    // 404 means the label is already gone, which is the outcome we wanted
    if (statusCode !== 200 && statusCode !== 404) {
      throw new Error(`Failed to remove label from runner ${id}. Status code: ${statusCode}`);
    }
  }
}

function assertOk(response, action) {
  if (response.statusCode !== 200 && response.statusCode !== 201) {
    const hint = response.statusCode === 401 || response.statusCode === 403 || response.statusCode === 404
      ? ' Check that the token can access self-hosted runners for this scope (see README, "Token").'
      : '';
    const detail = response.error ? ` ${response.error.message}` : '';
    throw new Error(`Failed to ${action}. Status code: ${response.statusCode}.${detail}${hint}`);
  }
}

function apiPathFor({ repository, organization, enterprise }) {
  if (organization && enterprise) {
    throw new Error('You cannot specify both organization and enterprise inputs. Please choose one.');
  }
  if (organization) return `orgs/${organization}/actions/runners`;
  if (enterprise) return `enterprises/${enterprise}/actions/runners`;
  return `repos/${repository}/actions/runners`;
}

module.exports = { RunnerClient, apiPathFor };
