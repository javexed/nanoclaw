// marked and DOMPurify are loaded from /marked.min.js and /dompurify.min.js at
// runtime and are listed as `external` in vite.config.ts, so the bundler leaves
// those imports alone. Nothing exists on disk for TypeScript to resolve, hence
// these ambient declarations. Wildcard patterns because a leading-slash module
// specifier is not matched by an exact `declare module` under bundler
// resolution.
declare module '*marked.min.js' {
  export const marked: {
    setOptions(o: Record<string, unknown>): void;
    parse(md: string): string;
  };
}

declare module '*dompurify.min.js' {
  const DOMPurify: { sanitize(html: string, cfg?: Record<string, unknown>): string };
  export default DOMPurify;
}
