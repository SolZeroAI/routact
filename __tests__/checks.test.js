const { runner } = require("./helpers")
const { normalizeWhen, evaluate, runCommand, parseVars } = require("../src/checks")
const { parseFallbacks } = require("../src/config")
const { chooseFallback, fallbackResults, checkPlatform, ConfigError } = require("../src/route")

const step = (labels, when = []) => ({ labels, when: normalizeWhen(when, "test") })
const context = (extra = {}) => ({ idleCount: () => 0, vars: {}, env: {}, ...extra })

describe("normalizeWhen", () => {
  it.each([
    [undefined, []],
    ["idle", ["idle"]],
    [{ var: "X" }, [{ var: "X" }]],
    [
      [{ var: "X" }, { env: "Y" }],
      [{ var: "X" }, { env: "Y" }],
    ],
    ["github-minutes", ["github-minutes"]],
    [{ "github-minutes": 10 }, [{ "github-minutes": 10 }]],
  ])("accepts %j", (when, expected) => {
    expect(normalizeWhen(when, "test")).toEqual(expected)
  })

  it.each([
    ["busy"],
    [{ var: "X", env: "Y" }],
    [{ idle: 0 }],
    [{ command: "" }],
    [{ any: [] }],
    [{ not: { nope: 1 } }],
    [{ "github-minutes": -1 }],
    [{ "github-minutes": "5" }],
  ])("rejects %j", (when) => {
    expect(() => normalizeWhen(when, "test")).toThrow(ConfigError)
  })
})

describe("evaluate", () => {
  it("checks variables", async () => {
    const vars = { ON: "true", OFF: "false", EMPTY: "", MODE: "blacksmith" }
    expect(await evaluate({ var: "ON" }, step([]), context({ vars }))).toBe(true)
    expect(await evaluate({ var: "OFF" }, step([]), context({ vars }))).toBe(false)
    expect(await evaluate({ var: "EMPTY" }, step([]), context({ vars }))).toBe(false)
    expect(await evaluate({ var: "MISSING" }, step([]), context({ vars }))).toBe(false)
    expect(await evaluate({ var: "MODE", equals: "blacksmith" }, step([]), context({ vars }))).toBe(
      true,
    )
  })

  it("checks environment variables", async () => {
    expect(await evaluate({ env: "X" }, step([]), context({ env: { X: "1" } }))).toBe(true)
  })

  it("counts idle runners for the step labels", async () => {
    const idleCount = (labels) => (labels[0] === "big" ? 2 : 0)
    expect(await evaluate("idle", step(["big"]), context({ idleCount }))).toBe(true)
    expect(await evaluate({ idle: 3 }, step(["big"]), context({ idleCount }))).toBe(false)
  })

  it("passes while GitHub Actions usage is within the included minutes or the spend limit", async () => {
    const githubUsage = jest.fn().mockResolvedValue(4.5)
    expect(await evaluate("github-minutes", step([]), context({ githubUsage }))).toBe(false)
    expect(await evaluate({ "github-minutes": 5 }, step([]), context({ githubUsage }))).toBe(true)
    expect(await evaluate({ "github-minutes": 4 }, step([]), context({ githubUsage }))).toBe(false)
    const unused = jest.fn().mockResolvedValue(0)
    expect(await evaluate("github-minutes", step([]), context({ githubUsage: unused }))).toBe(true)
  })

  it("fails a GitHub minutes check when usage cannot be read", async () => {
    const log = jest.fn()
    expect(await evaluate("github-minutes", step([]), context({ log }))).toBe(false)
    const githubUsage = jest.fn().mockRejectedValue(new Error("Status code: 403"))
    expect(await evaluate("github-minutes", step([]), context({ githubUsage, log }))).toBe(false)
    expect(log).toHaveBeenLastCalledWith("Could not read GitHub usage: Status code: 403")
  })

  it("combines checks with not and any", async () => {
    const vars = { A: "true" }
    expect(await evaluate({ not: { var: "A" } }, step([]), context({ vars }))).toBe(false)
    expect(await evaluate({ any: [{ var: "B" }, { var: "A" }] }, step([]), context({ vars }))).toBe(
      true,
    )
  })

  it("runs commands with the step labels in the environment", async () => {
    const run = jest.fn().mockResolvedValue(true)

    const result = await evaluate(
      { command: "check" },
      step(["blacksmith-2vcpu-ubuntu-2404"]),
      context({ run, commandEnv: { ROUTACT_POOL: "x" } }),
    )

    expect(result).toBe(true)
    expect(run.mock.calls[0][1].env).toEqual({
      ROUTACT_POOL: "x",
      ROUTACT_RUNS_ON: '["blacksmith-2vcpu-ubuntu-2404"]',
    })
  })
})

describe("runCommand", () => {
  it("passes on exit 0 and fails otherwise", async () => {
    expect(
      await runCommand('test "$ROUTACT_RUNS_ON" = "[]"', { env: { ROUTACT_RUNS_ON: "[]" } }),
    ).toBe(true)
    expect(await runCommand("exit 3")).toBe(false)
  })

  it("fails a command that runs too long", async () => {
    const log = jest.fn()
    expect(await runCommand("sleep 5", { timeoutSeconds: 0.2, log })).toBe(false)
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/timed out/))
  })
})

describe("parseVars", () => {
  it("parses JSON and treats empty as none", () => {
    expect(parseVars('{"A":"1"}')).toEqual({ A: "1" })
    expect(parseVars("")).toEqual({})
    expect(() => parseVars("nope")).toThrow(ConfigError)
  })
})

describe("fallback chains", () => {
  const pool = {
    name: "linux-x64",
    primary: ["self-hosted", "Linux", "X64"],
    primariesRequired: undefined,
    fallbacks: parseFallbacks(
      [
        { "runs-on": "self-hosted,Linux,X64,big", when: "idle" },
        { "runs-on": "blacksmith-4vcpu-ubuntu-2404", when: { var: "ROUTACT_BLACKSMITH_ENABLED" } },
        { "runs-on": "ubuntu-24.04" },
      ],
      "test",
    ),
  }

  it("parses plain labels as a single step", () => {
    expect(parseFallbacks("ubuntu-24.04", "test")).toEqual([{ labels: ["ubuntu-24.04"], when: [] }])
    expect(parseFallbacks(["linux", "x64"], "test")).toEqual([
      { labels: ["linux", "x64"], when: [] },
    ])
  })

  it("rejects a step without runs-on", () => {
    expect(() => parseFallbacks([{ when: "idle" }], "test")).toThrow(/no "runs-on"/)
  })

  it("uses the first step whose checks pass", async () => {
    const runners = [runner(1, ["self-hosted", "Linux", "X64", "big"])]

    const choice = await chooseFallback(pool, {
      runners,
      checkContext: { vars: { ROUTACT_BLACKSMITH_ENABLED: "true" } },
    })

    expect(choice.index).toBe(0)
  })

  it("moves down the chain", async () => {
    const runners = [runner(1, ["self-hosted", "Linux", "X64", "big"], { busy: true })]

    const choice = await chooseFallback(pool, {
      runners,
      checkContext: { vars: { ROUTACT_BLACKSMITH_ENABLED: "true" } },
    })

    expect(choice.step.labels).toEqual(["blacksmith-4vcpu-ubuntu-2404"])
    expect(choice.skipped).toEqual(['step 1 check "idle runner" failed'])
  })

  it("ends at the unconditional step", async () => {
    const choice = await chooseFallback(pool, { runners: [], checkContext: { vars: {} } })
    expect(choice.step.labels).toEqual(["ubuntu-24.04"])
  })

  it("uses the last step when every check fails", async () => {
    const conditional = { ...pool, fallbacks: pool.fallbacks.slice(0, 2) }
    const choice = await chooseFallback(conditional, { runners: [], checkContext: { vars: {} } })
    expect(choice.step.labels).toEqual(["blacksmith-4vcpu-ubuntu-2404"])
    expect(choice.exhausted).toBe(true)
  })

  it("skips self-hosted steps for fork pull requests", async () => {
    const results = await fallbackResults([pool], "fork", {
      skipSelfHosted: true,
      checkContext: { vars: { ROUTACT_BLACKSMITH_ENABLED: "yes" } },
    })

    expect(results["linux-x64"]).toMatchObject({
      labels: ["blacksmith-4vcpu-ubuntu-2404"],
      fallbackStep: 2,
    })
    expect(results["linux-x64"].reason).toBe("fork; fallback step 2, after step 1 is self-hosted")
  })
})

describe("platform check on chains", () => {
  it("names the step that does not match", () => {
    const pool = {
      name: "mac",
      primary: ["self-hosted", "macOS", "ARM64"],
      fallbacks: parseFallbacks(
        [{ "runs-on": "macos-15", when: { var: "A" } }, { "runs-on": "ubuntu-latest" }],
        "test",
      ),
    }

    expect(() => checkPlatform(pool, [], "error")).toThrow(
      /fallback step 2 \(ubuntu-latest\) does not match/,
    )
  })
})
