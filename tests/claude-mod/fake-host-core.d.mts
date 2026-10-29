export type FakeHostOptions = {
  config?: Record<string, unknown>
  emit: (message: Record<string, unknown>) => void
  sleep?: (ms: number) => Promise<void>
  exit?: (code: number) => void
  token?: string
  port?: number
}

export type FakeHostCore = {
  start: () => void
  rpc: (authorization: string | undefined, bodyText: string) => Promise<{ status: number; body: Record<string, unknown> }>
  token: string
  setPort: (port: number) => void
  calls: { method: string; params: Record<string, any> }[]
  handle: (method: string, params: Record<string, unknown>) => Promise<unknown>
}

export function createHostCore(options: FakeHostOptions): FakeHostCore
