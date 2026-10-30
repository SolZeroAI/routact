const fs = require("fs")
const path = require("path")
const { runner, FakeClient } = require("./helpers")
const { parseImages, newerLabel, findImage } = require("../src/images")
const { parseConfig } = require("../src/config")

const {
  parseTasks,
  parseFlags,
  validate,
  reviewImages,
  upgradeConfig,
  maintain,
} = require("../src/maintain")

const { ConfigError } = require("../src/errors")

// Snapshot of the runner-images README table, October 2026
const IMAGES = parseImages(
  fs.readFileSync(path.join(__dirname, "fixtures", "runner-images-README.md"), "utf8"),
)

const RAW = {
  organization: "SolZeroAI",
  pools: {
    "linux-x64": {
      primary: "self-hosted,Linux,X64",
      fallback: [
        { "runs-on": "blacksmith-4vcpu-ubuntu-2404", when: { var: "ROUTACT_BLACKSMITH_ENABLED" } },
        { "runs-on": "ubuntu-24.04" },
      ],
    },
    mac: { primary: "self-hosted,macOS,ARM64", fallback: "macos-14" },
  },
}

describe("parseImages", () => {
  it("reads labels, arch and status from the table", () => {
    expect(findImage(IMAGES, "ubuntu-24.04")).toMatchObject({ arch: "x64", status: "ga" })
    expect(findImage(IMAGES, "ubuntu-latest")).toMatchObject({ name: "Ubuntu 24.04" })
    expect(findImage(IMAGES, "macos-14")).toMatchObject({ status: "deprecated", arch: "arm64" })
    expect(findImage(IMAGES, "xcode-27")).toMatchObject({ status: "preview" })
    expect(findImage(IMAGES, "ubuntu-20.04")).toBeUndefined()
  })
})

describe("newerLabel", () => {
  it.each([
    ["ubuntu-24.04", "ubuntu-26.04"],
    ["ubuntu-22.04-arm", "ubuntu-26.04-arm"],
    ["macos-15", "macos-26"],
    ["macos-15-intel", "macos-26-intel"],
    ["windows-2022", "windows-2025"],
    ["ubuntu-26.04", undefined],
    ["ubuntu-latest", undefined],
  ])("%s -> %s", (label, expected) => {
    expect(newerLabel(IMAGES, label)).toBe(expected)
  })
})

describe("parseTasks and parseFlags", () => {
  it("defaults to every task and rejects unknown ones", () => {
    expect(parseTasks("")).toEqual(["validate", "images", "flags"])
    expect(parseTasks("flags")).toEqual(["flags"])
    expect(() => parseTasks("nope")).toThrow(ConfigError)
  })

  it("accepts strings and objects", () => {
    expect(parseFlags('{"A":"true","B":{"command":"exit 1"}}')).toEqual([
      { name: "A", command: "true" },
      { name: "B", command: "exit 1" },
    ])
    expect(() => parseFlags('{"bad name":"x"}')).toThrow(/not a valid variable name/)
    expect(() => parseFlags('{"A":""}')).toThrow(/needs a command/)
  })
})

describe("validate", () => {
  it("reports pools without runners and unset variables", () => {
    const config = parseConfig(JSON.stringify(RAW))

    const runners = [
      runner(1, ["self-hosted", "macOS", "ARM64"], { os: "macOS", status: "offline" }),
    ]

    const { errors, warnings } = validate({ config, runners, vars: {} })
    expect(errors).toEqual([])
    expect(warnings).toEqual([
      expect.stringMatching(/blacksmith-4vcpu-ubuntu-2404\) Linux\/unknown arch/),
      'Pool "linux-x64": no registered runner has all the primary labels self-hosted,Linux,X64, so it always falls back.',
      'Pool "linux-x64" fallback step 1 (blacksmith-4vcpu-ubuntu-2404): checks the variable ROUTACT_BLACKSMITH_ENABLED, which is not set, so the step is never used.',
      'Pool "mac": all 1 primary runners are offline.',
    ])
  })

  it("reports a platform mismatch as an error", () => {
    const config = parseConfig(
      '{"x":{"primary":"self-hosted,Linux,ARM64","fallback":"ubuntu-24.04"}}',
    )

    expect(validate({ config, runners: [], vars: {} }).errors[0]).toMatch(/architecture differ/)
  })
})

describe("reviewImages", () => {
  it("flags deprecated and retired labels and suggests upgrades", () => {
    const raw = {
      ...RAW,
      pools: { ...RAW.pools, old: { primary: "self-hosted,Linux,X64", fallback: "ubuntu-20.04" } },
    }

    const { errors, warnings, upgrades } = reviewImages({
      config: parseConfig(JSON.stringify(raw)),
      imageList: IMAGES,
    })

    expect(errors).toEqual([
      'Pool "mac" fallback step 1: "macos-14" is deprecated and will stop working; use "macos-26".',
      'Pool "old" fallback step 1: "ubuntu-20.04" is not a current GitHub-hosted label (retired or misspelled); use "ubuntu-26.04".',
    ])
    expect(warnings).toEqual([])
    expect(upgrades).toEqual({
      "ubuntu-24.04": "ubuntu-26.04",
      "macos-14": "macos-26",
      "ubuntu-20.04": "ubuntu-26.04",
    })
  })

  it("leaves non-GitHub labels alone", () => {
    const config = parseConfig(
      '{"x":{"primary":"self-hosted,Linux,X64","fallback":"blacksmith-2vcpu-ubuntu-2404"}}',
    )

    expect(reviewImages({ config, imageList: IMAGES })).toEqual({
      errors: [],
      warnings: [],
      upgrades: {},
    })
  })
})

describe("upgradeConfig", () => {
  it("replaces labels and keeps the config shape", () => {
    const upgraded = upgradeConfig(RAW, { "ubuntu-24.04": "ubuntu-26.04", "macos-14": "macos-26" })
    expect(upgraded.pools["linux-x64"].fallback[1]).toEqual({ "runs-on": "ubuntu-26.04" })
    expect(upgraded.pools["linux-x64"].fallback[0].when).toEqual({
      var: "ROUTACT_BLACKSMITH_ENABLED",
    })
    expect(upgraded.pools.mac.fallback).toBe("macos-26")
    expect(RAW.pools.mac.fallback).toBe("macos-14")
  })
})

describe("maintain", () => {
  const base = (extra = {}) => ({
    configText: JSON.stringify(RAW),
    client: new FakeClient([
      runner(1, ["self-hosted", "Linux", "X64"]),
      runner(2, ["self-hosted", "macOS", "ARM64"], { os: "macOS" }),
    ]),
    loadImages: async () => IMAGES,
    setVariable: jest.fn().mockResolvedValue(),
    ...extra,
  })

  it("sets flag variables only when they change, before validating", async () => {
    const options = base({
      flags: [
        { name: "ROUTACT_BLACKSMITH_ENABLED", command: "ok" },
        { name: "OTHER", command: "fail" },
      ],
      vars: { OTHER: "false" },
      run: async (command) => command === "ok",
    })

    const report = await maintain(options)
    expect(options.setVariable.mock.calls).toEqual([["ROUTACT_BLACKSMITH_ENABLED", "true"]])
    expect(report.flags).toEqual([
      { name: "ROUTACT_BLACKSMITH_ENABLED", value: "true", changed: true },
      { name: "OTHER", value: "false", changed: false },
    ])
    // The flag is set, so validation no longer warns about it
    expect(report.warnings.some((message) => message.includes("ROUTACT_BLACKSMITH_ENABLED"))).toBe(
      false,
    )
  })

  it("suggests an upgraded config without applying it", async () => {
    const options = base({ vars: { ROUTACT_BLACKSMITH_ENABLED: "true" } })
    const report = await maintain(options)
    expect(report.errors).toEqual([
      'Pool "mac" fallback step 1: "macos-14" is deprecated and will stop working; use "macos-26".',
    ])
    expect(JSON.parse(report.suggestedConfig).pools.mac.fallback).toBe("macos-26")
    expect(options.setVariable).not.toHaveBeenCalled()
  })

  it("applies upgrades when asked", async () => {
    const options = base({ applyUpgrades: true, tasks: ["images"] })
    const report = await maintain(options)
    expect(report.applied).toBe(true)
    expect(options.setVariable.mock.calls[0][0]).toBe("ROUTACT_CONFIG")
    expect(
      JSON.parse(options.setVariable.mock.calls[0][1]).pools["linux-x64"].fallback[1]["runs-on"],
    ).toBe("ubuntu-26.04")
  })

  it("reports an invalid config", async () => {
    const report = await maintain(base({ configText: '{"x":{"primary":"a"}}' }))
    expect(report.errors[0]).toMatch(/ROUTACT_CONFIG is invalid: .*no fallback labels/)
  })

  it("only runs flags when asked", async () => {
    const options = base({
      tasks: ["flags"],
      flags: [{ name: "A", command: "x" }],
      run: async () => false,
    })

    const report = await maintain(options)
    expect(report.errors).toEqual([])
    expect(options.client.calls).toEqual([])
  })

  it("treats an unreachable image list as a warning", async () => {
    const report = await maintain(
      base({
        tasks: ["images"],
        loadImages: async () => {
          throw new Error("offline")
        },
      }),
    )

    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual(["Could not check GitHub-hosted images: offline"])
  })
})
