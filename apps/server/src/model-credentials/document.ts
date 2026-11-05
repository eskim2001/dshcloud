import { stringify } from 'yaml'
import { assertCredentialRef, assertModelKey } from './rules.js'

/**
 * 新建工作区时写入 `$DSH_HOME/.credentials.yaml` 的文档。
 *
 * 用 version 1，而不是顶层扁平映射：上游 `credentials/set` 读写的就是 `refs`。
 * `records` 留空对象——oauth / 签名材料由 dsh 自己往后补，平台不注入、也不读。
 */
export function renderCredentialsYaml(refs: Readonly<Record<string, string>>): string {
  const ordered: Record<string, string> = {}
  for (const ref of Object.keys(refs).sort()) {
    assertCredentialRef(ref)
    const value = refs[ref]
    if (value === undefined) throw new Error('模型凭据文档渲染失败')
    assertModelKey(value)
    ordered[ref] = value
  }
  if (Object.keys(ordered).length === 0) throw new Error('没有可写入的模型凭据')
  const text = stringify({ version: 1, refs: ordered, records: {} })
  if (!text.startsWith('version: 1\n') || !text.includes('records: {}\n')) {
    throw new Error('模型凭据文档渲染失败')
  }
  return text.endsWith('\n') ? text : `${text}\n`
}
