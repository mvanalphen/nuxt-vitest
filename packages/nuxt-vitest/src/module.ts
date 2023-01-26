import { defineNuxtModule, installModule, logger, resolvePath } from '@nuxt/kit'
import type { UserConfig as VitestConfig } from 'vitest'
import { mergeConfig, InlineConfig as ViteConfig } from 'vite'
import { getVitestConfigFromNuxt } from './config'
import { getPort } from 'get-port-please'

export interface NuxtVitestOptions {
  startOnBoot?: boolean
  logToConsole?: boolean
  vitestConfig?: VitestConfig
}

/**
 * List of plugins that are not compatible with text env.
 * Hard-coded for now, should remove by PR to upstream.
 */
const vitePluginBlocklist = ['vite-plugin-vue-inspector', 'vite-plugin-inspect']

export default defineNuxtModule<NuxtVitestOptions>({
  meta: {
    name: 'nuxt-vitest',
    configKey: 'vitest',
  },
  defaults: {
    startOnBoot: false,
    logToConsole: false,
  },
  async setup(options, nuxt) {
    await installModule('vitest-environment-nuxt/module')

    if (!nuxt.options.dev) return

    // the nuxt instance is used by a standalone Vitest env, we skip this module
    if (process.env.TEST || process.env.VITE_TEST) return

    const rawViteConfigPromise = new Promise<ViteConfig>(resolve => {
      // Wrap with app:resolve to ensure we got the final vite config
      nuxt.hook('app:resolve', () => {
        nuxt.hook('vite:extendConfig', (config, { isClient }) => {
          if (isClient) resolve(config)
        })
      })
    })

    const PORT = await getPort({ port: 15555 })
    const URL = `http://localhost:${PORT}/__vitest__/`
    let loaded = false
    let promise: Promise<any> | undefined

    async function start() {
      const rawViteConfig = mergeConfig({}, await rawViteConfigPromise)

      const viteConfig = mergeConfig(
        await getVitestConfigFromNuxt({ nuxt, viteConfig: rawViteConfig }),
        <ViteConfig>{
          server: {
            middlewareMode: false,
          },
        }
      )

      viteConfig.plugins = (viteConfig.plugins || []).filter((p: any) => {
        return !vitePluginBlocklist.includes(p?.name)
      })

      process.env.__NUXT_VITEST_RESOLVED__ = 'true'
      const { startVitest } = (await import(
        await resolvePath('vitest/node')
      )) as typeof import('vitest/node')

      // For testing dev mode in CI, maybe expose an option to user later
      const vitestConfig: VitestConfig = process.env.NUXT_VITEST_DEV_TEST
        ? {
            ...options.vitestConfig,
            watch: false,
          }
        : {
            passWithNoTests: true,
            ...options.vitestConfig,
            reporters: options.logToConsole ? undefined : [{}], // do not report to console
            ui: true,
            open: false,
            api: {
              port: PORT,
            },
          }

      // TODO: Investigate segfault when loading config file in Nuxt
      viteConfig.configFile = false

      // Start Vitest
      const promise = startVitest('test', [], vitestConfig, viteConfig)

      if (process.env.NUXT_VITEST_DEV_TEST) {
        promise.then(v => v?.close()).then(() => process.exit())
        promise.catch(() => process.exit(1))
      }

      logger.info(`Vitest UI starting on ${URL}`)

      loaded = true
      promise
    }

    // @ts-ignore
    nuxt.hook('devtools:customTabs', tabs => {
      tabs.push({
        title: 'Vitest',
        name: 'vitest',
        icon: 'logos-vitest',
        view: loaded
          ? {
              type: 'iframe',
              src: URL,
            }
          : {
              type: 'launch',
              description: 'Start tests along with Nuxt',
              actions: [
                {
                  label: promise ? 'Starting...' : 'Start Vitest',
                  pending: !!promise,
                  handle: () => {
                    promise = promise || start()
                    return promise
                  },
                },
              ],
            },
      })
    })

    if (options.startOnBoot) {
      promise = promise || start()
      promise.then(() => {
        // @ts-expect-error
        nuxt.callHook('devtools:customTabs:refresh')
      })
    }
  },
})
