/**
 * Configuration normalization for `dsh-history-access`.
 *
 * Every field is optional and every bound is validated at load: a deployment
 * that writes a budget the tools cannot honour fails at plugin activation with
 * an actionable message instead of returning an empty or oversized page later.
 * {@link Config} adapts {@link normalizeConfig} to the Standard Schema contract
 * the Cordis Loader validates plugin config with
 * (`vendor/cordis/src/fiber.ts`, `resolveConfig`).
 *
 * @module dsh-history-access/lib/config
 */

/** Inclusive integer bounds one budget field accepts. */
const BOUNDS = Object.freeze({
  readMaxChars: Object.freeze([400, 1_000_000]),
  readMaxEvents: Object.freeze([1, 1_000]),
  searchMaxHits: Object.freeze([1, 200]),
  outlineMaxChars: Object.freeze([200, 1_000_000]),
})

/** Values `pointer` accepts. */
const POINTER_MODES = Object.freeze(['inject', 'off'])

/** Documented defaults for every configuration field. */
export const DEFAULT_CONFIG = Object.freeze({
  readMaxChars: 8000,
  readMaxEvents: 80,
  searchMaxHits: 20,
  outlineMaxChars: 4000,
  pointer: 'inject',
})

/** The complete field set; any other key is refused. */
export const CONFIG_FIELDS = Object.freeze(Object.keys(DEFAULT_CONFIG))

/** Thrown when configuration cannot be normalized; carries one issue per problem. */
export class ConfigError extends Error {
  /**
   * @param issues - every configuration problem found, in field order.
   */
  constructor(issues) {
    super(`history-access: invalid configuration:\n${issues.map(issue => `  - ${issue}`).join('\n')}`)
    this.name = 'ConfigError'
    this.issues = issues
  }
}

/**
 * Describe one integer field's bounds, for the rejection message.
 * @param name - field name.
 * @returns the human-readable bound clause.
 */
function boundText(name) {
  const [minimum, maximum] = BOUNDS[name]
  return `an integer between ${minimum} and ${maximum}`
}

/**
 * Validate one raw configuration value and report value defects.
 * @param raw - the row's configuration, absent when the row declares none.
 * @returns either the normalized configuration or every issue found.
 */
function validate(raw) {
  if (raw === undefined || raw === null) return { value: { ...DEFAULT_CONFIG } }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { issues: [{ message: 'configuration must be an object' }] }
  }
  const issues = []
  const value = { ...DEFAULT_CONFIG }
  for (const key of Object.keys(raw)) {
    if (!CONFIG_FIELDS.includes(key)) {
      issues.push({
        message: `unknown configuration field "${key}" (known fields: ${CONFIG_FIELDS.join(', ')})`,
        path: [key],
      })
    }
  }
  for (const name of Object.keys(BOUNDS)) {
    const provided = raw[name]
    if (provided === undefined) continue
    const [minimum, maximum] = BOUNDS[name]
    if (!Number.isInteger(provided) || provided < minimum || provided > maximum) {
      issues.push({
        message: `${name} must be ${boundText(name)} (got ${JSON.stringify(provided)})`,
        path: [name],
      })
      continue
    }
    value[name] = provided
  }
  if (raw.pointer !== undefined) {
    if (!POINTER_MODES.includes(raw.pointer)) {
      issues.push({
        message: `pointer must be one of ${POINTER_MODES.map(mode => `"${mode}"`).join(', ')} (got ${JSON.stringify(raw.pointer)})`,
        path: ['pointer'],
      })
    } else {
      value.pointer = raw.pointer
    }
  }
  return issues.length === 0 ? { value: Object.freeze(value) } : { issues }
}

/**
 * Normalize one row's configuration, failing loud on any defect.
 * @param raw - the row's configuration, absent when the row declares none.
 * @returns the frozen normalized configuration.
 * @throws {ConfigError} when a field is unknown or out of range.
 */
export function normalizeConfig(raw) {
  const result = validate(raw)
  if (result.issues !== undefined) {
    throw new ConfigError(result.issues.map(issue => issue.message))
  }
  return result.value
}

/**
 * Standard Schema adapter over {@link normalizeConfig}, consumed by the Loader
 * through `Config['~standard'].validate`.
 */
export const Config = Object.freeze({
  '~standard': Object.freeze({
    version: 1,
    vendor: 'dsh-history-access',
    validate,
  }),
})
