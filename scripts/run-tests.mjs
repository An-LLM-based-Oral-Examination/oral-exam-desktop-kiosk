import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testDistDir = path.join(rootDir, 'node_modules', '.tmp', 'test-dist')
const testElectronDistDir = path.join(rootDir, 'node_modules', '.tmp', 'test-dist-electron')
const tscEntry = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc')

rmSync(testDistDir, { recursive: true, force: true })
rmSync(testElectronDistDir, { recursive: true, force: true })
mkdirSync(testDistDir, { recursive: true })
mkdirSync(testElectronDistDir, { recursive: true })

// Compile core TypeScript modules to CommonJS JS so Node unit tests execute real production code.
const compile = spawnSync(
  process.execPath,
  [
    tscEntry,
    '--ignoreConfig',
    '--target',
    'ES2023',
    '--module',
    'CommonJS',
    '--jsx',
    'react-jsx',
    '--outDir',
    testDistDir,
    '--rootDir',
    'src',
    '--skipLibCheck',
    '--strict',
    'src/utils/transcript-diff.ts',
    'src/utils/crypto.ts',
    'src/utils/question-image.ts',
    'src/utils/formatters.ts',
    'src/services/api.ts',
    'src/services/offline-draft.ts',
    'src/services/turn-sync.ts',
    'src/types/mf04.types.ts',
    'src/vite-env.d.ts',
    'src/hooks/useAntiCheatMonitor.ts',
    'src/hooks/useKioskHeartbeat.ts',
    'src/hooks/useKioskRuntime.ts',
    'src/screens/BlockedScreen.tsx',
    'src/screens/SignInScreen.tsx',
    'src/screens/SubmittedScreen.tsx',
    'src/screens/WaitingTicketScreen.tsx',
    'src/screens/PreCheckScreen.tsx',
    'src/screens/LobbyScreen.tsx',
    'src/screens/ExamScreen.tsx',
    'src/App.tsx',
  ],
  {
    cwd: rootDir,
    stdio: 'inherit',
    shell: false,
  },
)

if (compile.status !== 0) {
  process.exit(compile.status ?? 1)
}

writeFileSync(path.join(testDistDir, 'package.json'), JSON.stringify({ type: 'commonjs' }), 'utf8')

const compileElectron = spawnSync(
  process.execPath,
  [
    tscEntry,
    '--ignoreConfig',
    '--target',
    'ES2022',
    '--module',
    'CommonJS',
    '--types',
    'node',
    '--esModuleInterop',
    '--outDir',
    testElectronDistDir,
    '--rootDir',
    'electron',
    '--skipLibCheck',
    '--strict',
    'electron/config.ts',
    'electron/device.ts',
    'electron/security.ts',
    'electron/windows-agent.ts',
    'node_modules/electron/electron.d.ts',
  ],
  {
    cwd: rootDir,
    stdio: 'inherit',
    shell: false,
  },
)

if (compileElectron.status !== 0) {
  process.exit(compileElectron.status ?? 1)
}

writeFileSync(path.join(testElectronDistDir, 'package.json'), JSON.stringify({ type: 'commonjs' }), 'utf8')

const testRun = spawnSync(process.execPath, ['--test'], {
  cwd: rootDir,
  stdio: 'inherit',
})

process.exit(testRun.status ?? 1)
