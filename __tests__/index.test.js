const fs = require("fs")
const os = require("os")
const path = require("path")
const { runner, FakeClient } = require("./helpers")

let mockClient

jest.mock("../src/github", () => {
  const actual = jest.requireActual("../src/github")

  return { ...actual, RunnerClient: jest.fn().mockImplementation(() => mockClient) }
})

const { main } = require("../index")

const DEFAULTS = {
  "fallback-on-error": "false",
  "fallback-on-fork-pr": "true",
  "platform-check": "error",
  claim: "false",
  "claim-ttl-minutes": "10",
}

let outputFile
let summaryFile

function setInputs(inputs) {
  for (const [name, value] of Object.entries({ ...DEFAULTS, ...inputs })) {
    process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] = value
  }
}

function outputs() {
  // GITHUB_OUTPUT uses heredoc blocks: name<<delimiter / value / delimiter
  const text = fs.readFileSync(outputFile, "utf8")
  const result = {}
  const pattern = /^(.+?)<<(.+)\n([\s\S]*?)\n\2$/gm
  let match

  while ((match = pattern.exec(text))) result[match[1]] = match[3]

  return result
}

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routact-"))
  outputFile = path.join(dir, "output")
  summaryFile = path.join(dir, "summary")
  fs.writeFileSync(outputFile, "")
  fs.writeFileSync(summaryFile, "")

  for (const key of Object.keys(process.env)) {
    if (key.startsWith("INPUT_")) delete process.env[key]
  }

  Object.assign(process.env, {
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    GITHUB_REPOSITORY: "SolZeroAI/routact",
    GITHUB_EVENT_NAME: "push",
    GITHUB_EVENT_PATH: "",
  })
  process.exitCode = undefined
  mockClient = new FakeClient([runner(1, ["self-hosted", "Linux", "X64"], { busy: true })])
})

afterAll(() => {
  process.exitCode = undefined
})

it("routes the single-pool inputs like upstream", async () => {
  setInputs({
    "github-token": "t",
    "primary-runner": "self-hosted,linux",
    "fallback-runner": "ubuntu-24.04",
  })
  await main()
  expect(outputs()).toMatchObject({
    "use-runner": '["self-hosted","linux"]',
    "is-primary": "true",
    runners: '{"default":["self-hosted","linux"]}',
  })
  expect(fs.readFileSync(summaryFile, "utf8")).toContain("Runner routing")
})

it("splits a multi-label fallback on error", async () => {
  mockClient.listRunners = async () => {
    throw new Error("boom")
  }

  setInputs({
    "github-token": "t",
    "primary-runner": "self-hosted,Linux,X64",
    "fallback-runner": "linux,x64",
    "fallback-on-error": "true",
    "platform-check": "off",
  })
  await main()
  expect(outputs()["use-runner"]).toBe('["linux","x64"]')
  expect(process.exitCode).toBeUndefined()
})

it("fails on error without fallback-on-error", async () => {
  mockClient.listRunners = async () => {
    throw new Error("boom")
  }

  setInputs({
    "github-token": "t",
    "primary-runner": "self-hosted",
    "fallback-runner": "ubuntu-24.04",
    "platform-check": "off",
  })
  await main()
  expect(process.exitCode).toBe(1)
})

it("sends fork pull requests to the fallback without a token", async () => {
  const eventPath = path.join(path.dirname(outputFile), "event.json")
  fs.writeFileSync(
    eventPath,
    JSON.stringify({ pull_request: { head: { repo: { full_name: "someone/routact" } } } }),
  )
  Object.assign(process.env, { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath })
  setInputs({ "primary-runner": "self-hosted,Linux,X64", "fallback-runner": "ubuntu-24.04" })
  await main()
  expect(outputs()).toMatchObject({ "use-runner": '["ubuntu-24.04"]', "is-primary": "false" })
  expect(mockClient.calls).toEqual([])
})

it("routes pools from config", async () => {
  setInputs({
    "github-token": "t",
    config: JSON.stringify({
      organization: "solzeroai",
      pools: {
        x64: { primary: "self-hosted,Linux,X64", fallback: "ubuntu-24.04" },
        arm: { primary: "self-hosted,Linux,ARM64", fallback: "ubuntu-24.04-arm" },
      },
    }),
  })
  await main()
  const result = outputs()
  expect(JSON.parse(result.runners)).toEqual({
    x64: ["self-hosted", "Linux", "X64"],
    arm: ["ubuntu-24.04-arm"],
  })
  expect(result["use-runner"]).toBeUndefined()
})

it("releases claims without failing when one is already gone", async () => {
  mockClient = new FakeClient([runner(5, ["self-hosted", "routact-claim-1-1-1-a"])])
  mockClient.removeLabel = jest
    .fn()
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error("nope"))
  setInputs({ "github-token": "t", release: "5:routact-claim-1-1-1-a,6:routact-claim-1-1-1-b" })
  await main()
  expect(mockClient.removeLabel).toHaveBeenCalledTimes(2)
  expect(process.exitCode).toBeUndefined()
})
