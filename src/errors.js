// Errors in the routing setup itself. These fail the job even with
// fallback-on-error, because falling back would hide a broken configuration.
class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = "ConfigError"
  }
}

module.exports = { ConfigError }
