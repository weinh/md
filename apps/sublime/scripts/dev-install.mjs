#!/usr/bin/env node
/**
 * Sync the built plugin/ directory into the local Sublime Text Packages folder
 * for manual testing. Run after "npm run build" (the dev-install script does).
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(__dirname, `..`)
const pluginDir = path.join(pkgRoot, `plugin`)

function packagesDir() {
  const platform = os.platform()
  const home = os.homedir()
  if (platform === `darwin`)
    return path.join(home, `Library`, `Application Support`, `Sublime Text`, `Packages`)
  if (platform === `win32`)
    return path.join(process.env.APPDATA ?? path.join(home, `AppData`, `Roaming`), `Sublime Text`, `Packages`)
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, `.config`), `sublime-text`, `Packages`)
}

const target = path.join(packagesDir(), `MdPreview`)

if (!fs.existsSync(path.join(pluginDir, `renderer`, `server.cjs`))) {
  console.error(`plugin/renderer/server.cjs missing — run "npm run build" first`)
  process.exit(1)
}

fs.mkdirSync(target, { recursive: true })

if (os.platform() === `darwin`) {
  // rsync fast-paths the ~15MB runtime node_modules on repeated installs
  execSync(`rsync -a --delete --exclude .DS_Store --exclude __pycache__ "${pluginDir}/" "${target}/"`, { stdio: `inherit` })
}
else {
  fs.cpSync(pluginDir, target, { recursive: true, force: true })
}

console.log(`✔ installed MdPreview => ${target}`)
console.log(`  Restart Sublime Text (or reopen the project), then run "Md Preview: Open Preview".`)
console.log(`  If a previous version is running, use "Md Preview: Restart Renderer Server" first.`)
