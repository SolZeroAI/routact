const fs = require("fs")
const os = require("os")
const path = require("path")
const { isForkPullRequest } = require("../src/event")

function eventFile(payload) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "routact-")), "event.json")
  fs.writeFileSync(file, JSON.stringify(payload))

  return file
}

const pr = (headRepo) => eventFile({ pull_request: { head: { repo: headRepo } } })

describe("isForkPullRequest", () => {
  it("detects a fork", () => {
    expect(
      isForkPullRequest({
        eventName: "pull_request",
        eventPath: pr({ full_name: "someone/routact" }),
        repository: "SolZeroAI/routact",
      }),
    ).toBe(true)
  })

  it("accepts a same-repo PR even when the repo is itself a fork", () => {
    expect(
      isForkPullRequest({
        eventName: "pull_request",
        eventPath: pr({ full_name: "solzeroai/routact", fork: true }),
        repository: "SolZeroAI/routact",
      }),
    ).toBe(false)
  })

  it("treats a deleted fork as a fork", () => {
    expect(
      isForkPullRequest({
        eventName: "pull_request_target",
        eventPath: pr(null),
        repository: "a/b",
      }),
    ).toBe(true)
  })

  it("ignores other events", () => {
    expect(
      isForkPullRequest({
        eventName: "push",
        eventPath: pr({ full_name: "x/y" }),
        repository: "a/b",
      }),
    ).toBe(false)
  })
})
