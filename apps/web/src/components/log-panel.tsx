import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button.js'

/** 留太多行浏览器会卡——超出就从头部丢。 */
const MAX_LINES = 2000
/** 连续失败这么多次就断开，别再敲服务端（EventSource 自己会无限重连）。 */
const MAX_ERRORS = 3

type LogState = 'connecting' | 'live' | 'ended' | 'failed'

/**
 * 容器日志面板（SSE）。
 *
 * 用原生 `EventSource` 而不是 `request()` 封装——它自带流式解析和重连，
 * 但只认 cookie，所以 `withCredentials` 必须显式打开。
 *
 * 服务端正常结束时会先发 `end` 再断连，这里收到就主动 `close()`，
 * 否则 EventSource 会把它当断线一直重连。
 */
export function LogPanel({ src }: { src: string }) {
  const { t } = useTranslation()
  const [lines, setLines] = useState<string[]>([])
  const [state, setState] = useState<LogState>('connecting')
  /** 失败后的「重试」：+1 让 effect 重跑、重开一条 EventSource。 */
  const [attempt, setAttempt] = useState(0)
  const preRef = useRef<HTMLPreElement>(null)
  /** 用户没往上翻时才自动滚到底，翻着看历史时别把他拽走。 */
  const stickRef = useRef(true)

  useEffect(() => {
    let ended = false
    let errors = 0
    setLines([])
    setState('connecting')

    const es = new EventSource(src, { withCredentials: true })

    es.addEventListener('log', (event) => {
      errors = 0
      setState('live')
      const line = (event as MessageEvent<string>).data
      setLines((prev) => {
        const next = prev.length >= MAX_LINES ? prev.slice(prev.length - MAX_LINES + 1) : prev.slice()
        next.push(line)
        return next
      })
    })

    es.addEventListener('end', () => {
      ended = true
      setState('ended')
      es.close()
    })

    es.onopen = () => {
      if (!ended) setState('live')
    }

    es.onerror = () => {
      if (ended) return
      // 401 / 404 / 409 会立刻失败并重连，连续几次就别试了
      if (++errors >= MAX_ERRORS) {
        setState('failed')
        es.close()
      }
    }

    return () => {
      ended = true
      es.close()
    }
  }, [src, attempt])

  useEffect(() => {
    const el = preRef.current
    if (el !== null && stickRef.current) el.scrollTop = el.scrollHeight
  }, [lines])

  // 空占位必须跟着状态走：连接失败摆失败文案（附重试），连接中摆连接中 ——
  // 「暂无日志输出」只在真的连上/结束了却一行都没有时出现（502 曾被当成空态）。
  const emptyText =
    state === 'failed'
      ? t('instanceDetail.logFailedBody')
      : state === 'connecting'
        ? t('instanceDetail.logState.connecting')
        : t('instanceDetail.logEmpty')

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className={state === 'failed' ? 'text-destructive' : undefined}>
          {t(`instanceDetail.logState.${state}`)}
        </span>
        <div className="flex items-center gap-1">
          {state === 'failed' && (
            <Button variant="ghost" size="sm" onClick={() => setAttempt((n) => n + 1)}>
              {t('instanceDetail.logRetry')}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setLines([])} disabled={lines.length === 0}>
            {t('instanceDetail.logClear')}
          </Button>
        </div>
      </div>
      <pre
        ref={preRef}
        onScroll={() => {
          const el = preRef.current
          if (el === null) return
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
        className="h-72 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
      >
        {lines.length === 0 ? emptyText : lines.join('\n')}
      </pre>
    </div>
  )
}
