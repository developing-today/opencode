export * as SharedEvents from "./shared-events.js"

export type SubscribeOptions = {
  readonly signal?: AbortSignal
  /** Reports transport activity on the shared stream, including keepalive frames that carry no event. */
  readonly onActivity?: () => void
  /** Resumes the shared stream after this SSE id when it opens. A subscriber joining an open stream does not change it. */
  readonly lastEventID?: string
  /** Reports the SSE id of each event as this subscriber takes it, so a cursor only advances on consumption. */
  readonly onEventId?: (id: string) => void
}

export type Resume = {
  readonly lastEventID?: string
  readonly onEventId: (id: string) => void
}

export function make<A extends { readonly type: string }>(
  connect: (signal: AbortSignal, onActivity: () => void, resume: Resume) => AsyncIterable<A>,
) {
  type Completion = { readonly error: unknown } | Record<string, never>
  type Delivery = { readonly value: A; readonly id?: string }
  type Subscriber = {
    push: (value: A, id?: string) => void
    finish: (completion: Completion) => void
    activity?: () => void
  }
  type Connection = {
    controller: AbortController
    subscribers: Set<Subscriber>
    connected?: A
    lastEventID?: string
    // Set by the transport just before it yields the event that the loop is about to read.
    eventID?: string
  }

  let current: Connection | undefined
  const capacity = 4_096

  function stop(connection: Connection) {
    connection.connected = undefined
    connection.controller.abort()
    if (current === connection) current = undefined
  }

  async function run(connection: Connection) {
    let iterator: AsyncIterator<A> | undefined
    let completion: Completion = {}
    try {
      if (connection.controller.signal.aborted) return
      iterator = connect(
        connection.controller.signal,
        () => {
          connection.subscribers.forEach((subscriber) => subscriber.activity?.())
        },
        {
          lastEventID: connection.lastEventID,
          onEventId: (id) => {
            connection.eventID = id
          },
        },
      )[Symbol.asyncIterator]()
      while (!connection.controller.signal.aborted) {
        connection.eventID = undefined
        const item = await iterator.next()
        if (item.done || connection.controller.signal.aborted) break
        if (item.value.type === "server.connected") connection.connected = item.value
        const id = connection.eventID
        connection.subscribers.forEach((subscriber) => subscriber.push(item.value, id))
      }
    } catch (error) {
      completion = { error }
    } finally {
      stop(connection)
      try {
        await iterator?.return?.()
      } catch (error) {
        if (!("error" in completion)) completion = { error }
      }
      connection.subscribers.forEach((subscriber) => subscriber.finish(completion))
    }
  }

  return {
    subscribe(options?: SubscribeOptions): AsyncIterable<A> {
      return {
        [Symbol.asyncIterator]() {
          const pending: ReturnType<typeof Promise.withResolvers<IteratorResult<A>>>[] = []
          const queued: Delivery[] = []
          let started = false
          let completion: Completion | undefined
          let connection: Connection | undefined

          function finish(result: Completion, discard = true) {
            completion = result
            if (discard) queued.length = 0
            options?.signal?.removeEventListener("abort", abort)
            if (connection?.subscribers.delete(subscriber) && !connection.subscribers.size) stop(connection)
            pending.splice(0).forEach((request) => {
              if ("error" in result) request.reject(result.error)
              else request.resolve({ done: true, value: undefined })
            })
          }

          function abort() {
            finish({})
          }

          // The id is reported when the event is handed to the consumer, not when it is queued.
          function take(delivery: Delivery): IteratorResult<A> {
            if (delivery.id !== undefined) options?.onEventId?.(delivery.id)
            return { done: false, value: delivery.value }
          }

          const subscriber: Subscriber = {
            activity: options?.onActivity,
            finish(result) {
              finish(result, false)
            },
            push(value, id) {
              if (completion) return
              const request = pending.shift()
              if (request) {
                request.resolve(take({ value, id }))
                return
              }
              if (queued.length === capacity) {
                finish({ error: new Error(`Event subscriber exceeded its ${capacity}-event capacity`) })
                return
              }
              queued.push({ value, id })
            },
          }

          function start() {
            if (completion) return
            const fresh = !current
            connection = current ?? {
              controller: new AbortController(),
              subscribers: new Set<Subscriber>(),
              lastEventID: options?.lastEventID,
            }
            current = connection
            connection.subscribers.add(subscriber)
            if (connection.connected) void subscriber.push(connection.connected)
            if (fresh) void run(connection)
          }

          return {
            next(): Promise<IteratorResult<A>> {
              const delivery = queued.shift()
              if (delivery) return Promise.resolve(take(delivery))
              if (completion) {
                if ("error" in completion) return Promise.reject(completion.error)
                return Promise.resolve({ done: true, value: undefined })
              }
              if (options?.signal?.aborted) {
                abort()
                return Promise.resolve({ done: true, value: undefined })
              }
              const request = Promise.withResolvers<IteratorResult<A>>()
              pending.push(request)
              if (!started) {
                started = true
                options?.signal?.addEventListener("abort", abort, { once: true })
                start()
              }
              return request.promise
            },
            return(): Promise<IteratorResult<A>> {
              finish({})
              return Promise.resolve({ done: true, value: undefined })
            },
          }
        },
      }
    },
  }
}
