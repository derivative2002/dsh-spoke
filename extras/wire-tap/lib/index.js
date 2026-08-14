// wire-tap — capture the runtime's llm/stream traffic to a JSONL file.
//
// Sits on the llm/stream middleware seam: every request (provider, model,
// system, messages, tools) and its full chunk stream — plus any thrown
// error — is appended as one JSON line. This is the evidence layer for
// audits: what did the model actually see, and what did it actually say.
//
// Passive by design: chunks are yielded through unchanged; capture happens
// in `finally`, so a mid-stream crash still leaves its partial evidence.
import fs from 'node:fs'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'

export const name = 'wire-tap'
export const inject = ['llm']
export const Config = z.object({ outputPath: z.string().required() })

export function apply(ctx, config) {
  const outputPath = path.resolve(config.outputPath)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  ctx.on('llm/stream', async function* (options, next) {
    const chunks = []
    let thrown
    try {
      for await (const chunk of next()) {
        chunks.push(chunk)
        yield chunk
      }
    } catch (error) {
      thrown = error instanceof Error ? { name: error.name, message: error.message } : { value: String(error) }
      throw error
    } finally {
      fs.appendFileSync(outputPath, `${JSON.stringify({
        capturedAt: new Date().toISOString(),
        request: { provider: options.provider, model: options.model, system: options.system, messages: options.messages, tools: options.tools },
        chunks,
        thrown,
      })}\n`)
    }
  })
}
