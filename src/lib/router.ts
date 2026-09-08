// 极简 hash 路由。
// 用 hash 而不是 history，是为了后期能直接套 Tauri（tauri:// 协议下 pushState 会白屏）。
// 只有两个页面，没必要为此引入 react-router。
import { useEffect, useState } from 'react'

export type Route = { name: 'library' } | { name: 'read'; id: string }

export function parseHash(hash: string): Route {
  const clean = hash.replace(/^#\/?/, '')
  const match = clean.match(/^read\/(.+)$/)
  return match ? { name: 'read', id: decodeURIComponent(match[1]) } : { name: 'library' }
}

export function navigate(to: string): void {
  window.location.hash = to
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash))

  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  return route
}
