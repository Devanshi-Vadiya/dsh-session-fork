/**
 * Build-time CSS Modules contract (see tsdown.client.config.ts's
 * dsh-css-modules-inline plugin): a `.module.css` import resolves to its
 * hashed class map at bundle time.
 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
