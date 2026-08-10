declare module './lru-cache.mjs' {
  export interface LruCache<V = unknown> {
    get(key: string): V | undefined
    set(key: string, value: V): void
    has(key: string): boolean
    delete(key: string): boolean
    clear(): void
    readonly size: number
  }
  export function createLruCache<V = unknown>(maxEntries?: number): LruCache<V>
}
