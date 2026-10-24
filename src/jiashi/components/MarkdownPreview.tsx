/**
 * MarkdownPreview —— markdown 渲染器（ReactMarkdown + GFM + KaTeX + breaks）
 *
 * 预览态与「混合编辑器的非焦点块」共用同一个渲染器，保证两态外观严格一致：
 * 用户点开一块时看到的差异，只有「源码 vs 渲染」，没有别的视觉跳变。
 */
import React, { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkBreaks from 'remark-breaks'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'

function MarkdownPreview({
  text,
  isDarkMode,
}: {
  text: string
  isDarkMode: boolean
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
      rehypePlugins={[rehypeKatex]}
      components={{
        code({ className, children, ...props }) {
          const isInline = !className
          if (isInline) {
            return (
              <code
                className="inline-code"
                style={{
                  background: isDarkMode ? '#313244' : '#f0f0f0',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  fontSize: '0.9em',
                }}
                {...props}
              >
                {children}
              </code>
            )
          }
          return (
            <pre
              style={{
                background: isDarkMode ? '#1a1a2e' : '#f5f5f5',
                padding: '10px 14px',
                borderRadius: '6px',
                overflow: 'auto',
                fontSize: '0.85em',
              }}
            >
              <code className={className} {...props}>
                {children}
              </code>
            </pre>
          )
        },
        h1: ({ children }) => (
          <h1 style={{ fontSize: '1.5em', margin: '0.6em 0 0.3em', fontWeight: 700 }}>
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2 style={{ fontSize: '1.3em', margin: '0.5em 0 0.3em', fontWeight: 600 }}>
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3 style={{ fontSize: '1.15em', margin: '0.4em 0 0.2em', fontWeight: 600 }}>
            {children}
          </h3>
        ),
        blockquote: ({ children }) => (
          <blockquote
            style={{
              borderLeft: `3px solid ${isDarkMode ? '#6c8cff' : '#4f7cff'}`,
              paddingLeft: '12px',
              margin: '6px 0',
              opacity: 0.85,
            }}
          >
            {children}
          </blockquote>
        ),
        p: ({ children }) => <p style={{ margin: '0.3em 0' }}>{children}</p>,
        ul: ({ children }) => <ul style={{ paddingLeft: '1.4em', margin: '0.3em 0' }}>{children}</ul>,
        ol: ({ children }) => <ol style={{ paddingLeft: '1.4em', margin: '0.3em 0' }}>{children}</ol>,
      }}
    >
      {text}
    </ReactMarkdown>
  )
}

/** memo：混合编辑器里只有「焦点块」在变，其余块不该跟着重渲染 */
export default memo(MarkdownPreview)
