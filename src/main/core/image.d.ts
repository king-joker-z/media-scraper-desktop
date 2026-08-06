declare module './image.mjs' {
  export function isJpegName(name: string): boolean
  export function convertToJpg(source: string, target: string): Promise<string>
}
