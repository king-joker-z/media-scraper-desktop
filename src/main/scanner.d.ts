declare module './scanner.mjs' {
  export function createScanPlan(root: string): Promise<unknown>
}
