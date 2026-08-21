import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repositoryRoot = path.resolve(process.cwd(), '../..')
const readDeploymentFile = (relativePath: string) => readFileSync(path.join(repositoryRoot, relativePath), 'utf8')

test('control unit runs unprivileged with separate configuration', () => {
  const unit = readDeploymentFile('deploy/systemd/archivist-control.service')
  assert.match(unit, /^User=archivist-control$/m)
  assert.match(unit, /^Group=archivist-control$/m)
  assert.match(unit, /^SupplementaryGroups=systemd-journal$/m)
  assert.match(unit, /^EnvironmentFile=\/etc\/archivist\/control\.env$/m)
  assert.doesNotMatch(unit, /^User=root$/m)
  assert.doesNotMatch(unit, /archivist\.env/)
  assert.match(unit, /^CapabilityBoundingSet=$/m)
  assert.match(unit, /^NoNewPrivileges=true$/m)
  // V8's JIT must be able to change memory protections at runtime.
  assert.doesNotMatch(unit, /^MemoryDenyWriteExecute=true$/m)
  // Host telemetry needs the non-process files in /proc (notably cpuinfo).
  assert.doesNotMatch(unit, /^ProcSubset=pid$/m)
})

test('installer makes immutable releases readable by unprivileged services', () => {
  const installer = readDeploymentFile('deploy/install-bare-metal.sh')
  assert.match(installer, /chmod -R a\+rX,u\+w,go-w "\$RELEASE_DIR"/)
  assert.match(installer, /install -d -m 0755 "\$runtime_parent"/)
  assert.match(installer, /persistent path is not accessible to \$RUNTIME_USER/)
})

test('polkit rule is scoped to one caller, unit, and three verbs', () => {
  const rule = readDeploymentFile('deploy/polkit/50-archivist-control.rules')
  assert.match(rule, /subject\.user === 'archivist-control'/)
  assert.match(rule, /subject\.system_unit === 'archivist-control\.service'/)
  assert.match(rule, /unit === 'archivist\.service'/)
  for (const verb of ['start', 'stop', 'restart']) assert.match(rule, new RegExp(`verb === '${verb}'`))
  for (const forbidden of ['enable', 'disable', 'reload', 'daemon-reload']) assert.doesNotMatch(rule, new RegExp(`verb === '${forbidden}'`))
  assert.match(rule, /return polkit\.Result\.NO/)
})

test('runtime and control use the atomic current release link', () => {
  for (const unitName of ['archivist.service', 'archivist-control-agent.service', 'archivist-control.service']) {
    const unit = readDeploymentFile(`deploy/systemd/${unitName}`)
    assert.match(unit, /\/opt\/archivist\/current/)
  }
})

test('control agent is socket-only, protects secrets, and limits writable locations', () => {
  const unit = readDeploymentFile('deploy/systemd/archivist-control-agent.service')
  assert.match(unit, /^User=root$/m)
  assert.match(unit, /^Group=archivist-control$/m)
  assert.match(unit, /^PrivateNetwork=true$/m)
  assert.match(unit, /^RestrictAddressFamilies=AF_UNIX$/m)
  assert.match(unit, /^CapabilityBoundingSet=CAP_DAC_READ_SEARCH CAP_DAC_OVERRIDE$/m)
  assert.match(unit, /^AmbientCapabilities=CAP_DAC_READ_SEARCH CAP_DAC_OVERRIDE$/m)
  assert.match(unit, /^InaccessiblePaths=\/etc\/archivist .*archivist\.sqlite .*catalogue\.sqlite .*\/backups .*\/torrents .*\/resume$/m)
  assert.match(unit, /^ProtectSystem=strict$/m)
  assert.match(unit, /^ProtectHome=read-only$/m)
  assert.match(unit, /^ReadWritePaths=-\/home -\/mnt -\/media -\/srv -\/tmp -\/var\/tmp -\/var\/lib\/archivist\/data\/indexer-definitions \/var\/lib\/archivist-control-agent$/m)
  assert.doesNotMatch(unit, /bash|sh -c|docker\.sock/)
})
