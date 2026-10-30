import { tegami } from "tegami"
import { runCli } from "tegami/cli"
import { github } from "tegami/plugins/github"
import { actionRelease } from "./action-release.mts"

const repository = process.env.GITHUB_REPOSITORY?.trim() || "SolZeroAI/routact"

const release = tegami({
  conventionalCommits: false,
  npm: {
    client: "nub",
    updateLockFile: false,
  },
  plugins: [
    // github() opens the version pull request. The package is private, so that
    // plugin does not publish to npm or create the release tag. actionRelease()
    // creates the vX.Y.Z tag and the GitHub release from the publish lock.
    github({
      repo: repository,
      release: {
        eager: false,
        create({ pkg, plan }) {
          const sections = (plan.packages.get(pkg.id)?.changelogs ?? []).flatMap((entry) =>
            entry.sections.flatMap((section) => [`### ${section.title}`, "", section.content, ""]),
          )

          return {
            title: `Routact v${pkg.version}`,
            notes: sections.join("\n").trim(),
          }
        },
      },
      versionPr: {
        base: "master",
        branch: "tegami/version-packages",
      },
    }),
    actionRelease(),
  ],
})

await runCli(release)
