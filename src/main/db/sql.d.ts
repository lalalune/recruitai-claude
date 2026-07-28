// esbuild loads .sql with the `text` loader; Vite/tsc need the shape declared.
declare module '*.sql' {
  const content: string;
  export default content;
}
