const { parseConfig, resolvePools } = require("../src/config")
const { ConfigError } = require("../src/route")

const CONFIG = JSON.stringify({
  organization: "solzeroai",
  pools: {
    "linux-arm": {
      primary: "self-hosted,Linux,ARM64",
      fallback: "ubuntu-24.04-arm",
      "primaries-required": 1,
    },
    mac: { primary: ["self-hosted", "macOS", "ARM64"], fallback: ["macos-15"] },
  },
})

describe("parseConfig", () => {
  it("parses pools and the organization", () => {
    const config = parseConfig(CONFIG)
    expect(config.organization).toBe("solzeroai")
    expect(config.pools).toEqual([
      {
        name: "linux-arm",
        primary: ["self-hosted", "Linux", "ARM64"],
        fallbacks: [{ labels: ["ubuntu-24.04-arm"], when: [] }],
        primariesRequired: 1,
      },
      {
        name: "mac",
        primary: ["self-hosted", "macOS", "ARM64"],
        fallbacks: [{ labels: ["macos-15"], when: [] }],
        primariesRequired: undefined,
      },
    ])
  })

  it("accepts a bare object of pools", () => {
    expect(parseConfig('{"x":{"primary":"a","fallback":"b"}}').pools[0].name).toBe("x")
  })

  it("returns undefined for an empty input", () => {
    expect(parseConfig("")).toBeUndefined()
  })

  it.each([
    ["not json", /not valid JSON/],
    ["[]", /must be a JSON object/],
    ['{"pools":{}}', /does not define any pools/],
    ['{"x":{"primary":"a"}}', /no fallback labels/],
  ])("rejects %s", (text, message) => {
    expect(() => parseConfig(text)).toThrow(message)
  })
})

describe("resolvePools", () => {
  it("builds a default pool from the single-pool inputs", () => {
    expect(
      resolvePools({
        primaryRunner: "self-hosted, linux",
        fallbackRunner: "linux,x64",
        primariesRequired: "",
      }),
    ).toEqual([
      {
        name: "default",
        primary: ["self-hosted", "linux"],
        fallbacks: [{ labels: ["linux", "x64"], when: [] }],
        primariesRequired: undefined,
      },
    ])
  })

  it("requires primary and fallback together", () => {
    expect(() => resolvePools({ primaryRunner: "self-hosted" })).toThrow(ConfigError)
  })

  it("filters config pools by name", () => {
    const pools = resolvePools({ config: parseConfig(CONFIG), only: "mac" })
    expect(pools.map((pool) => pool.name)).toEqual(["mac"])
  })

  it("rejects unknown pool names", () => {
    expect(() => resolvePools({ config: parseConfig(CONFIG), only: "gpu" })).toThrow(
      /known pools: linux-arm, mac/,
    )
  })
})
