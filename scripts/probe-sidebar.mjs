/**
 * Probe the mobile sidebar opening: find the nav toggle, click it, and
 * capture the visible sidebar-root geometry over time.
 *
 * Usage: node scripts/probe-sidebar.mjs <tarball>
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import {
  createMobileProfile, dismissOnboarding, launchDsh, openPairing, pairMobilePage, removeTemporaryRoot,
} from './mobile-boot-fixture.mjs'

const DSH_BIN = process.env.DSH_BOOT_SMOKE_BIN
  ?? '/home/hathaway/.npm-global/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'
const tarball = process.argv[2]

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-jank-'))
  let browser
  let dsh
  try {
    const home = await createMobileProfile(root, { tarball, dshBin: DSH_BIN })
    dsh = launchDsh(root, home, DSH_BIN)
    const baseUrl = await dsh.ready()
    browser = await chromium.launch()
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const desktopPage = await desktop.newPage()
    const pairUrl = await openPairing(desktopPage, baseUrl, dsh.logs)

    const phoneContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      reducedMotion: 'no-preference',
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
    })
    const phone = await phoneContext.newPage()
    await pairMobilePage(phone, pairUrl, dsh.logs)
    await dismissOnboarding(phone)
    await phone.waitForTimeout(1500)

    const clicked = await phone.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')]
      const target = buttons.find((b) => {
        const r = b.getBoundingClientRect()
        return r.top < 80 && r.left < 100 && r.width > 20 && r.height > 20 && r.width < 80
      })
      if (target === undefined) return false
      target.click()
      return true
    })
    console.log('CLICKED=' + clicked)

    const delays = [0, 40, 80, 120, 180, 260, 400, 800]
    const samples = []
    for (const delay of delays) {
      await phone.waitForTimeout(delay - (samples.length === 0 ? 0 : delays[samples.length - 1]))
      const sample = await phone.evaluate(() => {
        const read = (el) => {
          if (el === null) return null
          const r = el.getBoundingClientRect()
          const cs = getComputedStyle(el)
          return {
            rectWidth: Math.round(r.width),
            offsetWidth: el.offsetWidth,
            cssWidth: cs.width,
            transform: cs.transform,
            opacity: cs.opacity,
            animation: cs.animationName,
            open: el.getAttribute('data-open'),
          }
        }
        return {
          root: read(document.querySelector('[data-dsh-mobile-sidebar-root]')),
          aside: read(document.querySelector('.dshm-drawer')),
        }
      })
      samples.push({ delay, sample })
    }
    console.log(JSON.stringify({ clicked, samples }))
  } finally {
    if (browser !== undefined) await browser.close()
    if (dsh !== undefined) await dsh.close()
    try { await removeTemporaryRoot(root, 'dsh-mobile-jank-') } catch { /* keep output */ }
  }
}

await main()