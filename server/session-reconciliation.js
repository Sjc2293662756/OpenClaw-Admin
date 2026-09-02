import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import {
  PRODUCTION_DATABASE_PATH,
  runSessionReconciliation,
} from './lib/session-reconciliation.js'

export async function runSessionReconciliationCli({ DatabaseClass = Database } = {}) {
  const result = await runSessionReconciliation({
    DatabaseClass,
    databasePath: PRODUCTION_DATABASE_PATH,
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (result.status !== 'ok') process.exitCode = 2
  return result
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) await runSessionReconciliationCli()
