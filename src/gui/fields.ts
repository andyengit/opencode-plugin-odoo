/** The `odoo.conf` values the panel edits by default. */
export const CONF_KEYS = [
  "db_host",
  "db_port",
  "db_user",
  "db_password",
  "admin_passwd",
  "http_port",
  "workers",
  "max_cron_threads",
  "limit_time_cpu",
  "limit_time_real",
  "log_level",
  "dev",
] as const

/** Options the panel manages elsewhere (the addons list and the workspace scaffold), so they are not listed as added. */
export const CONF_MANAGED = ["addons_path", "data_dir"]

export function isConfKey(key: string): boolean {
  return (CONF_KEYS as readonly string[]).includes(key) || CONF_MANAGED.includes(key)
}
