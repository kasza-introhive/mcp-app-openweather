/// <reference types="vite/client" />

// CSS Modules: `styles.foo` is a generated class name string.
declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}
