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

/** Official capabilities intentionally enabled in the research edition. */
export const USER_SURFACE_ROWS: readonly string[] = [
  'open-in-app', 'ui-open-in-app', 'ui-sidebar-terminal', 'ui-trajectory',
  'time-context', 'schedule', 'ui-schedule',
  'browser-use', 'browser-use-playwright',
  'lsp', 'lsp-stdio',
]

/** Developer controls the research edition keeps out of its product surface. */
export const DEVELOPER_ROWS: readonly string[] = [
  'session-log-download', 'ui-cordis', 'ui-agent-preset',
]

/**
 * The disabled rows that inherited Web scenarios temporarily compose again
 * to keep exercising those plugins.
 */
export const INHERITED_SCENARIO_ROWS: readonly string[] = [...TELEMETRY_ROWS, ...DEVELOPER_ROWS]
