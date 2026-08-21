import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSystemdShow, resolveService } from '../src/server/host.js'

test('parseSystemdShow preserves values containing equals signs', () => {
  assert.deepEqual(parseSystemdShow('ActiveState=active\nDescription=value=with=equals\nMainPID=42\n'), {
    ActiveState: 'active',
    Description: 'value=with=equals',
    MainPID: '42',
  })
})

test('resolveService enforces the service allowlist', () => {
  assert.equal(resolveService('../../ssh'), null)
  assert.equal(resolveService('ssh.service'), null)
  assert.deepEqual(resolveService('runtime'), {
    id: 'runtime',
    unit: process.env.ARCHIVIST_CONTROL_RUNTIME_UNIT || 'archivist.service',
    label: 'Archivist runtime',
  })
})
