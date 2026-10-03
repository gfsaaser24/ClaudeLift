// Dev helper: dry-run a push plan against Claude Desktop's claude.ai page
// through its Main Process Debugger (Developer → Enable Main Process
// Debugger). GET calls only — it never writes.
// Usage: npx tsx scripts/push-dry-run.ts <plan.json> <outputDir>
import { readFileSync } from 'node:fs'
import { PushPlanSchema } from '../src/shared/ipc'
import { openDesktopExecutor } from '../src/main/desktop-inspector'
import { pushPlan } from '../src/main/project-push'

const [planFile, outputDir] = process.argv.slice(2)
if (planFile === undefined || outputDir === undefined) {
  console.error('usage: push-dry-run.ts <plan.json> <outputDir>')
  process.exit(2)
}
const plan = PushPlanSchema.parse(JSON.parse(readFileSync(planFile, 'utf8')))
const exec = await openDesktopExecutor(process.execPath)
try {
  const res = await pushPlan(exec, {
    plan,
    planFile,
    keys: plan.projects.map((p) => p.key),
    dryRun: true,
    expectEmail: null,
    outputDir,
    signal: new AbortController().signal,
    onProgress: () => undefined
  })
  console.log(`account: ${res.account.email} (${res.account.orgName}) · projects there: ${res.account.projectNames.join(', ')}`)
  for (const p of res.projects) {
    console.log(`${p.action.padEnd(6)} ${p.name}  [${p.library.planned} files, ${p.memory.planned} memory]${p.reason ? ' — ' + p.reason : ''}`)
  }
  console.log(`receipt: ${res.receiptFile}`)
} finally {
  exec.dispose()
}
