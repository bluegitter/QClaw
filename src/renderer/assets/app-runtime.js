const modulePreloadLinkRel = "modulepreload"
const vitePreloadCache = {}

export function installModulePreloadPolyfill() {
  const relList = document.createElement("link").relList
  if (relList && relList.supports && relList.supports(modulePreloadLinkRel)) {
    return
  }

  for (const link of document.querySelectorAll('link[rel="modulepreload"]')) {
    processPreloadLink(link)
  }

  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== "childList") {
        continue
      }
      for (const node of mutation.addedNodes) {
        if (node.tagName === "LINK" && node.rel === "modulepreload") {
          processPreloadLink(node)
        }
      }
    }
  }).observe(document, { childList: true, subtree: true })
}

function processPreloadLink(link) {
  if (link.ep) {
    return
  }
  link.ep = true
  fetch(link.href, getFetchOptions(link))
}

function getFetchOptions(link) {
  const options = {}
  if (link.integrity) {
    options.integrity = link.integrity
  }
  if (link.referrerPolicy) {
    options.referrerPolicy = link.referrerPolicy
  }
  if (link.crossOrigin === "use-credentials") {
    options.credentials = "include"
  } else if (link.crossOrigin === "anonymous") {
    options.credentials = "omit"
  } else {
    options.credentials = "same-origin"
  }
  return options
}

function resolveAssetUrl(assetPath, importerUrl) {
  return new URL(assetPath, importerUrl).href
}

export function vitePreload(loader, dependencies, importerUrl) {
  let preloadWork = Promise.resolve()

  if (dependencies && dependencies.length > 0) {
    const links = document.getElementsByTagName("link")
    const nonceMeta = document.querySelector("meta[property=csp-nonce]")
    const nonce = nonceMeta?.nonce || nonceMeta?.getAttribute("nonce")

    preloadWork = Promise.allSettled(
      dependencies.map((dependency) => {
        const href = resolveAssetUrl(dependency, importerUrl)
        if (href in vitePreloadCache) {
          return undefined
        }

        vitePreloadCache[href] = true

        const isStylesheet = href.endsWith(".css")
        const selectorSuffix = isStylesheet ? '[rel="stylesheet"]' : ""

        if (importerUrl) {
          for (let index = links.length - 1; index >= 0; index -= 1) {
            const link = links[index]
            if (link.href === href && (!isStylesheet || link.rel === "stylesheet")) {
              return undefined
            }
          }
        } else if (document.querySelector(`link[href="${href}"]${selectorSuffix}`)) {
          return undefined
        }

        const link = document.createElement("link")
        link.rel = isStylesheet ? "stylesheet" : modulePreloadLinkRel
        if (!isStylesheet) {
          link.as = "script"
        }
        link.crossOrigin = ""
        link.href = href
        if (nonce) {
          link.setAttribute("nonce", nonce)
        }
        document.head.appendChild(link)

        if (!isStylesheet) {
          return undefined
        }

        return new Promise((resolve, reject) => {
          link.addEventListener("load", resolve)
          link.addEventListener("error", () => {
            reject(new Error(`Unable to preload CSS for ${href}`))
          })
        })
      }),
    )
  }

  return preloadWork.then((results) => {
    for (const result of results || []) {
      if (result.status === "rejected") {
        const event = new Event("vite:preloadError", { cancelable: true })
        event.payload = result.reason
        window.dispatchEvent(event)
        if (!event.defaultPrevented) {
          throw result.reason
        }
      }
    }

    return loader().catch((error) => {
      const event = new Event("vite:preloadError", { cancelable: true })
      event.payload = error
      window.dispatchEvent(event)
      if (!event.defaultPrevented) {
        throw error
      }
    })
  })
}
