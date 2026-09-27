import { describe, expect, it } from 'vitest'
import { hostLabel, normalizeAddress } from '../src/address.js'

const url = (raw: string) => {
  const result = normalizeAddress(raw)
  return result && 'url' in result ? result.url : result
}

describe('normalizeAddress', () => {
  it('fills in http and the default port for local hosts', () => {
    expect(url('192.168.1.10')).toBe('http://192.168.1.10:2424')
    expect(url('  nas  ')).toBe('http://nas:2424')
    expect(url('nas.local')).toBe('http://nas.local:2424')
    expect(url('localhost')).toBe('http://localhost:2424')
  })

  it('keeps an explicit port and assumes http with it', () => {
    expect(url('192.168.1.10:8080')).toBe('http://192.168.1.10:8080')
    expect(url('archivist.example.com:2424')).toBe('http://archivist.example.com:2424')
  })

  it('assumes a TLS reverse proxy for public-looking domains', () => {
    expect(url('archivist.example.com')).toBe('https://archivist.example.com')
  })

  it('respects a typed scheme', () => {
    expect(url('http://archivist.example.com')).toBe('http://archivist.example.com')
    expect(url('HTTPS://10.0.0.5:8443/')).toBe('https://10.0.0.5:8443')
  })

  it('trims a pasted Player URL back to the server', () => {
    expect(url('http://192.168.1.10:2424/player/')).toBe('http://192.168.1.10:2424')
    expect(url('192.168.1.10/player')).toBe('http://192.168.1.10:2424')
  })

  it('treats an empty field as no address, and rejects nonsense', () => {
    expect(normalizeAddress('   ')).toBeNull()
    expect(normalizeAddress('ftp://nas')).toEqual({ error: 'Use an http:// or https:// address' })
    expect(normalizeAddress('http://')).toEqual({ error: 'That does not look like an address' })
  })

  it('names a server after its host', () => {
    expect(hostLabel('http://192.168.1.10:2424')).toBe('192.168.1.10')
  })
})
