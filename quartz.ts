import path from "node:path"
import { visit } from "unist-util-visit"
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

// `@quartz-community/crawl-links` resolves links with "shortest" matching.
// Two folders can both contain e.g. `1 - Introduzione.svg`, and its fallback
// also mis-resolves links starting with `..`; both cases drop the folder and
// point at the site root. Resolving relative targets against the note's own
// slug first turns them into unique content-root paths, which crawl-links then
// resolves correctly (matching exactly one file, or via its fallback).
const resolveRelativeLinks = {
  name: "ResolveRelativeLinks",
  markdownPlugins: () => [
    () => (tree: unknown, file: { data: { slug?: string } }) => {
      const slug = file.data.slug
      if (!slug) return
      const dir = path.posix.dirname(slug)

      // Obsidian-flavored markdown slugifies `#page=3` (and PDF++ suffixes like
      // `#page=3&selection=...&color=...`) into `#page3...`, which PDF viewers
      // no longer understand. Restore `#page=N` for all PDF links.
      const restorePdfFragment = (filePath: string, fragment: string) =>
        /\.pdf$/i.test(filePath)
          ? fragment.replace(
              /^#page(\d+)(?:(?:selection|color).*)?$/i,
              "#page=$1",
            )
          : fragment

      const rewrite = (url: string, isImage: boolean) => {
        if (
          !url ||
          /^[a-z][a-z0-9+.-]*:/i.test(url) ||
          url.startsWith("/") ||
          url.startsWith("#")
        ) {
          return url
        }

        const hash = url.indexOf("#")
        const anchor = hash === -1 ? "" : url.slice(hash)
        const rawTarget = hash === -1 ? url : url.slice(0, hash)

        const keepPathWithPdfAnchor = () => {
          const fixedAnchor = restorePdfFragment(rawTarget, anchor)
          return fixedAnchor === anchor ? url : `${rawTarget}${fixedAnchor}`
        }

        // Links without `./` or `../` are vault-relative wikilinks; leave path
        // resolution to crawl-links, while still restoring PDF page fragments.
        if (!isImage && !rawTarget.startsWith(".")) return keepPathWithPdfAnchor()

        const trailingSlash = rawTarget.endsWith("/")
        let target = rawTarget
        try {
          target = decodeURIComponent(rawTarget)
        } catch {}
        const resolved = path.posix.normalize(path.posix.join(dir, target))
        if (resolved === "." || resolved.startsWith("..")) {
          return keepPathWithPdfAnchor()
        }

        return `${resolved}${trailingSlash ? "/" : ""}${restorePdfFragment(resolved, anchor)}`
      }

      visit(tree as any, (node: any) => {
        if (node.type === "link" && typeof node.url === "string") {
          node.url = rewrite(node.url, false)
        } else if (node.type === "image" && typeof node.url === "string") {
          node.url = rewrite(node.url, true)
        }
      })
    },
  ],
}

// Quartz 5 reads quartz.config.yaml and does not interpolate environment
// variables into it. Keep BASE_URL runtime-configurable by overriding the
// parsed configuration here.
const rawBaseUrl = process.env.BASE_URL ?? "localhost"
const baseUrl = rawBaseUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "")

const config = await loadQuartzConfig({ baseUrl })
config.plugins.transformers.push(resolveRelativeLinks as any)

export default config
export const layout = await loadQuartzLayout()
