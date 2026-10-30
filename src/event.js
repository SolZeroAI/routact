const fs = require("fs")

const PR_EVENTS = [
  "pull_request",
  "pull_request_target",
  "pull_request_review",
  "pull_request_review_comment",
]

// True when the run was triggered by a pull request from a fork. Those runs
// get no secrets, and running untrusted code on self-hosted runners is unsafe,
// so they always go to the fallback.
function isForkPullRequest({ eventName, eventPath, repository }) {
  if (!PR_EVENTS.includes(eventName) || !eventPath) return false
  let payload

  try {
    payload = JSON.parse(fs.readFileSync(eventPath, "utf8"))
  } catch {
    return false
  }

  const pullRequest = payload.pull_request

  if (!pullRequest) return false
  const head = pullRequest.head && pullRequest.head.repo

  // A deleted fork leaves head.repo null; treat it as a fork
  if (!head) return true

  // head.repo.fork is not used: it is also true for same-repo PRs when the base repo is itself a fork
  return head.full_name.toLowerCase() !== String(repository).toLowerCase()
}

module.exports = { isForkPullRequest }
