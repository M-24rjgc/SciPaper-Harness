/**
 * Rows of the base and Web bundles that the research edition's Web patch
 * (`cordis.patch.yml`) ships disabled. The bundle's own spec, the Desktop
 * composition spec and the Web e2e harnesses read these lists, so a row added
 * to the patch is added here once.
 */

/** Telemetry and feedback: a rating or `/feedback` authorises uploading the Session log. */
export const TELEMETRY_ROWS: readonly string[] = [
  'session-telemetry-otel', 'command-feedback', 'message-feedback', 'ui-message-feedback',
]

/** Open In, both halves; the Web e2e scaffold switches these on a scenario's own launch facts. */
export const OPEN_IN_APP_ROWS: readonly string[] = ['open-in-app', 'ui-open-in-app']

/** The other developer controls: Session-log download, Cordis badge, preset and plugin pages, terminal, trajectory. */
export const DEVELOPER_ROWS: readonly string[] = [
  'session-log-download', 'ui-cordis', 'ui-agent-preset', 'ui-sidebar-terminal', 'ui-trajectory',
]

/**
 * The disabled rows that the inherited Web scenarios compose again so they
 * keep exercising those plugins: every row above except Open In.
 */
export const INHERITED_SCENARIO_ROWS: readonly string[] = [...TELEMETRY_ROWS, ...DEVELOPER_ROWS]
