// SVG files are bundled as their markup text (esbuild loader `text`).
declare module '*.svg' {
  const markup: string;
  export default markup;
}
