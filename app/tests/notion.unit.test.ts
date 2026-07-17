/**
 * Unit tests for the pure Notion helpers (Task 13):
 * extractPageId, chunkBlocks, pickUploadMode, safeFilename.
 *
 * client.ts has no Electron imports, so these run in plain node.
 */
import { describe, expect, it } from 'vitest'
import {
  MULTI_PART_CHUNK_BYTES,
  chunkBlocks,
  extractPageId,
  pickUploadMode,
  safeFilename
} from '../src/main/notion/client'

const MB = 1024 * 1024

describe('extractPageId', () => {
  it('plain page URL → hyphenated 8-4-4-4-12 id', () => {
    expect(extractPageId('https://www.notion.so/25c1f2c8a5b84a01b0537b8a5b21e177')).toBe(
      '25c1f2c8-a5b8-4a01-b053-7b8a5b21e177'
    )
  })

  it('database URL with ?v= view id → returns the PATH id, not the view id', () => {
    expect(
      extractPageId(
        'https://www.notion.so/acme/8a3f0e5b7c214d3e9f0a1b2c3d4e5f60?v=00112233445566778899aabbccddeeff'
      )
    ).toBe('8a3f0e5b-7c21-4d3e-9f0a-1b2c3d4e5f60')
  })

  it('title-slug URL → id at the end wins', () => {
    expect(
      extractPageId('https://www.notion.so/My-Project-Notes-25c1f2c8a5b84a01b0537b8a5b21e177')
    ).toBe('25c1f2c8-a5b8-4a01-b053-7b8a5b21e177')
  })

  it('already-hyphenated id is accepted and lowercased', () => {
    expect(extractPageId('https://www.notion.so/25C1F2C8-A5B8-4A01-B053-7B8A5B21E177')).toBe(
      '25c1f2c8-a5b8-4a01-b053-7b8a5b21e177'
    )
  })

  it('invalid inputs → null', () => {
    expect(extractPageId('https://example.com/some-page')).toBeNull()
    expect(extractPageId('not a url at all')).toBeNull()
    expect(extractPageId('')).toBeNull()
    // 31 hex chars — one short of an id
    expect(extractPageId(`https://www.notion.so/${'a'.repeat(31)}`)).toBeNull()
  })
})

describe('chunkBlocks', () => {
  const blocksOf = (n: number): number[] => Array.from({ length: n }, (_, i) => i)

  it.each([
    { count: 0, chunks: [] as number[][] },
    { count: 99, chunks: [99] },
    { count: 100, chunks: [100] },
    { count: 101, chunks: [100, 1] },
    { count: 250, chunks: [100, 100, 50] }
  ])('$count blocks → chunk sizes $chunks', ({ count, chunks }) => {
    const input = blocksOf(count)
    const result = chunkBlocks(input)
    expect(result.map((chunk) => chunk.length)).toEqual(chunks)
    // nothing lost, order preserved
    expect(result.flat()).toEqual(input)
  })

  it('respects a custom chunk size', () => {
    expect(chunkBlocks(blocksOf(7), 3).map((c) => c.length)).toEqual([3, 3, 1])
  })

  it('rejects a non-positive chunk size', () => {
    expect(() => chunkBlocks(blocksOf(5), 0)).toThrow(RangeError)
  })
})

describe('pickUploadMode', () => {
  it('1MB → single', () => {
    expect(pickUploadMode(1 * MB)).toEqual({ mode: 'single' })
  })

  it('exactly 20MB → still single', () => {
    expect(pickUploadMode(20 * MB)).toEqual({ mode: 'single' })
  })

  it('21MB → multi_part in 10MB parts (3 parts: 10+10+1)', () => {
    expect(pickUploadMode(21 * MB)).toEqual({
      mode: 'multi_part',
      parts: 3,
      partSize: MULTI_PART_CHUNK_BYTES
    })
  })

  it('95MB → 10 parts of 10MB', () => {
    const mode = pickUploadMode(95 * MB)
    expect(mode).toEqual({ mode: 'multi_part', parts: 10, partSize: 10 * MB })
    if (mode.mode === 'multi_part') {
      // parts math: all-but-last full parts + remainder cover the size
      expect((mode.parts - 1) * mode.partSize).toBeLessThan(95 * MB)
      expect(mode.parts * mode.partSize).toBeGreaterThanOrEqual(95 * MB)
    }
  })
})

describe('safeFilename', () => {
  it('keeps a short title + task id and appends .zip', () => {
    const name = safeFilename('Weekly report', 'local_1234abcd')
    expect(name).toBe('Weekly report-local_1234abcd.zip')
  })

  it('truncates a long title but preserves the full task id', () => {
    const taskId = `local_${'a'.repeat(36)}` // 42 chars, like a real id
    const name = safeFilename('T'.repeat(300), taskId)
    expect(name.endsWith(`${taskId}.zip`)).toBe(true)
    expect(name.length).toBeLessThanOrEqual(80 + '.zip'.length)
  })

  it('strips invalid filename characters', () => {
    const name = safeFilename('bad:name/with*chars?"<>|and\\slash', 'local_1')
    expect(name).not.toMatch(/[\\/:*?"<>|]/)
    expect(name.endsWith('.zip')).toBe(true)
  })

  it('a title far beyond Notion’s 900-byte filename cap collapses to ≤80+4 chars', () => {
    const name = safeFilename('x'.repeat(2000), 'local_task')
    expect(name.length).toBeLessThanOrEqual(80 + '.zip'.length)
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThan(900)
    expect(name.endsWith('.zip')).toBe(true)
  })

  it('empty inputs fall back to a usable name', () => {
    expect(safeFilename('', '')).toBe('cowork-bundle.zip')
    expect(safeFilename('///***', '')).toBe('cowork-bundle.zip')
  })

  it('never leaves Windows-invalid trailing dots or spaces before .zip', () => {
    const name = safeFilename('Ends with dots...', '')
    expect(name).toBe('Ends with dots.zip')
  })
})
