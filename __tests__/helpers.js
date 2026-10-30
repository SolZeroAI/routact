// In-memory stand-in for RunnerClient
function runner(id, labels, { status = "online", busy = false, os = "Linux", name } = {}) {
  return {
    id,
    name: name || `runner-${id}`,
    os,
    status,
    busy,
    labels: labels.map((label) => ({ name: label })),
  }
}

class FakeClient {
  constructor(runners) {
    this.runners = runners
    this.calls = []
    // Hook to simulate another router acting between our calls
    this.afterAddLabel = () => {}
  }

  find(id) {
    return this.runners.find((candidate) => candidate.id === id)
  }

  async listRunners() {
    this.calls.push(["list"])

    return JSON.parse(JSON.stringify(this.runners))
  }

  async getRunner(id) {
    this.calls.push(["get", id])

    return JSON.parse(JSON.stringify(this.find(id)))
  }

  async addLabel(id, label) {
    this.calls.push(["add", id, label])
    this.find(id).labels.push({ name: label })
    this.afterAddLabel(id, label)
  }

  async removeLabel(id, label) {
    this.calls.push(["remove", id, label])
    const target = this.find(id)
    target.labels = target.labels.filter((existing) => existing.name !== label)
  }
}

module.exports = { runner, FakeClient }
