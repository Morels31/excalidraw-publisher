import { loadQuartzConfig, loadQuartzLayout } from "./quartz/plugins/loader/config-loader"
import { componentRegistry } from "./quartz/components/registry"
import type { QuartzPluginData } from "./quartz/plugins/vfile"

// Folder pages sort by modified date by default, and YAML cannot carry a
// function. Override the plugin option before the config is instantiated.
const byTitle = (left: QuartzPluginData, right: QuartzPluginData) => {
  const leftFolder = left.slug?.endsWith("/index") ?? false
  const rightFolder = right.slug?.endsWith("/index") ?? false
  if (leftFolder !== rightFolder) return leftFolder ? -1 : 1

  const leftTitle = left.frontmatter?.title ?? left.slug ?? ""
  const rightTitle = right.frontmatter?.title ?? right.slug ?? ""
  return leftTitle.localeCompare(rightTitle, undefined, {
    numeric: true,
    sensitivity: "base",
  })
}

componentRegistry.setOptionOverrides("@quartz-community/folder-page", {
  sort: byTitle,
})

// Quartz 5 reads quartz.config.yaml and does not interpolate environment
// variables into it. Keep BASE_URL runtime-configurable by overriding the
// parsed configuration here.
const rawBaseUrl = process.env.BASE_URL ?? "localhost"
const baseUrl = rawBaseUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "")

const config = await loadQuartzConfig({ baseUrl })

export default config
export const layout = await loadQuartzLayout()
