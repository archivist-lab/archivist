import { describe, expect, it } from 'vitest'
import { pickNext, type Box } from '../src/spatial.js'

const box = (left: number, top: number, width = 100, height = 50): Box => ({ left, top, right: left + width, bottom: top + height })

describe('pickNext', () => {
  const from = box(200, 200)
  const candidates = [
    { item: 'right-same-row', box: box(340, 200) },
    { item: 'right-far', box: box(700, 200) },
    { item: 'right-diagonal', box: box(320, 420) },
    { item: 'below', box: box(200, 300) },
    { item: 'above', box: box(210, 100) },
    { item: 'left', box: box(40, 205) },
  ]

  it('prefers the nearest element in the same row', () => {
    expect(pickNext(from, candidates, 'right')).toBe('right-same-row')
  })

  it('moves along a column', () => {
    expect(pickNext(from, candidates, 'down')).toBe('below')
    expect(pickNext(from, candidates, 'up')).toBe('above')
    expect(pickNext(from, candidates, 'left')).toBe('left')
  })

  it('stays put at an edge', () => {
    expect(pickNext(box(0, 0), [{ item: 'x', box: box(0, 100) }], 'left')).toBeNull()
  })
})
