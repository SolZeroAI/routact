import { execFileSync } from "node:child_process"

// A stable release tag such as v2.3.1. Prereleases (v2.3.1-rc.1) do not match.
const STABLE_RELEASE = /^v(?<major>0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/

const listed = execFileSync("git", ["tag", "--points-at", "HEAD"], { encoding: "utf8" })

const majors = new Set<string>()

for (const tag of listed.split("\n")) {
  const major = STABLE_RELEASE.exec(tag.trim())?.groups?.major

  if (major !== undefined) majors.add(`v${major}`)
}

if (majors.size !== 1) {
  console.log("HEAD has no single stable vX.Y.Z release tag. No major tag was moved.")
  process.exit(0)
}

const [major] = majors

if (process.env.GITHUB_ACTIONS !== "true") {
  console.log(`Would move ${major} to HEAD. Not pushing outside GitHub Actions.`)
  process.exit(0)
}

execFileSync("git", ["tag", "-f", `${major}`])

execFileSync("git", ["push", "origin", `refs/tags/${major}:refs/tags/${major}`, "--force"])

console.log(`Moved ${major} to HEAD.`)
