import { loadQuartzConfig, loadQuartzLayout } from "./quartz/plugins/loader/config-loader"

// Quartz 5 reads quartz.config.yaml and does not interpolate environment
// variables into it. Keep BASE_URL runtime-configurable by overriding the
// parsed configuration here.
const rawBaseUrl = process.env.BASE_URL ?? "localhost"
const baseUrl = rawBaseUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "")

const config = await loadQuartzConfig({ baseUrl })

export default config
export const layout = await loadQuartzLayout()
