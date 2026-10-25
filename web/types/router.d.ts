import 'vue-router'

declare module 'vue-router' {
  interface RouteMeta { title?: string, anonymous?: boolean, permissions?: string[] }
}
