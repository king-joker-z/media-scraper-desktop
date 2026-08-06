declare module './op-log.mjs' {
  export function writeOpLog(dir: string, module: string, payload: object): Promise<string>
  export function listOpLogs(
    dir: string,
    limit?: number
  ): Promise<{ file: string; module: string; finishedAt: string; summary: string }[]>
}
