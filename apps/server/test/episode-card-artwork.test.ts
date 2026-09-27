import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serializeEpisodeSummary, toMediaCard } from '../src/player/serializers.js'

const episode = (overrides: Record<string, unknown> = {}) => ({
  id: 11, series_id: 2, season_number: 1, episode_number: 3, title: 'Pilot', file_path: '/media/e.mkv',
  series_title: 'Dark', series_poster: '/p.jpg', series_logo: '/logo.png', series_backdrop: '/backdrop.jpg', still_path: null,
  ...overrides,
})

test('an episode card takes its show’s logo and backdrop', () => {
  const card = toMediaCard(serializeEpisodeSummary(episode()))
  assert.equal(card.logoUrl, '/logo.png')
  assert.equal(card.backdropUrl, '/backdrop.jpg')
  assert.equal(card.landscapeUrl, '/backdrop.jpg', 'no still, so the tile uses the show backdrop too')
})

test('an episode with a still keeps it on the tile, with the show behind the hero', () => {
  const card = toMediaCard(serializeEpisodeSummary(episode({ still_path: '/still.jpg' })))
  assert.equal(card.landscapeUrl, '/still.jpg')
  assert.equal(card.backdropUrl, '/backdrop.jpg')
})

test('a show with no backdrop falls back to the still', () => {
  const card = toMediaCard(serializeEpisodeSummary(episode({ still_path: '/still.jpg', series_backdrop: null })))
  assert.equal(card.backdropUrl, '/still.jpg')
})
