# Security

Report a vulnerability in this action through GitHub private vulnerability reporting on [SolZeroAI/routact](https://github.com/SolZeroAI/routact/security). Please do not open a public issue for a token leak, a way to route untrusted code to a self-hosted runner, or a way to bypass the fork pull request rule.

Routact reads self-hosted runners with the token you pass, and with `claim` it adds and removes runner labels. Give that token only the permissions in the README. Prefer a GitHub App installation token over a personal access token.

A pull request from a fork always gets the fallback runner, and Routact makes no API call for it. Do not remove that rule. Self-hosted runners must not run untrusted code.
