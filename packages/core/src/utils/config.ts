/**
 * Sanitizes an API key or configuration value by trimming whitespace 
 * and removing surrounding quotes.
 */
export function sanitizeConfigValue(value: string | undefined): string {
  if (!value) return ''
  return value.trim().replace(/^["']|["']$/g, '')
}
