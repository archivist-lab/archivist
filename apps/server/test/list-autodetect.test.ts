import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ARR_AUTODETECT_TARGETS, detectArrInstances } from '../src/list-imports/routes.js'

test('autodetect probes only the two fixed Docker addresses', async () => {
  assert.deepEqual(
    ARR_AUTODETECT_TARGETS.map(target => ({ type: target.type, url: target.url })),
    [
      { type: 'radarr', url: 'http://radarr:7878' },
      { type: 'sonarr', url: 'http://sonarr:8989' },
    ],
  )

  const probed: string[] = []
  const results = await detectArrInstances(async target => {
    probed.push(`${target.url}/ping`)
    return target.type === 'radarr' ? 200 : null
  })

  assert.deepEqual(probed.sort(), [
    'http://radarr:7878/ping',
    'http://sonarr:8989/ping',
  ])
  assert.equal(results.find(result => result.type === 'radarr')?.detected, true)
  assert.equal(results.find(result => result.type === 'sonarr')?.detected, false)
})
