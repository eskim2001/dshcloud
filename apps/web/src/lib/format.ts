/** 把 MiB 显示成人读得懂的尺寸：整 GB 不带小数，不到 1 GB 用 MB。 */
export function formatMb(mb: number): string {
  if (mb < 1024) return `${Math.round(mb)} MB`
  const gb = mb / 1024
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`
}

/**
 * 从入口 URL 取出主机名。
 *
 * 用户要复制/看的是**地址**，不是带入口 token 的完整路径——那条 URL 里的 token 是一次性的，
 * 贴出去既没用又碍眼。
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * 从镜像引用里取出 tag（`ghcr.io/acme/img:1.2.3` → `1.2.3`）。
 *
 * 升级下拉框里真正有差异的只有 tag：候选**只可能来自平台自己的仓库**（服务端发布时强制校验），
 * 而那个前缀已经显示在「当前版本」那一栏。整串塞进选择框的话，每个选项前五十个字符都一样，
 * 真正的差异反而被挤没了。
 *
 * 没有 tag 时原样返回 —— `ImageRefSchema` 允许不带 tag，也允许带端口的 registry
 * （`reg:5000/img`），冒号在最后一个 `/` 之前就属于那两种，不能当成 tag 分隔符。
 */
export function imageTagOf(ref: string): string {
  const at = ref.lastIndexOf(':')
  if (at === -1 || at < ref.lastIndexOf('/')) return ref
  return ref.slice(at + 1)
}

/**
 * 用户面版本短标：`dsh-instance:0.1.6-alpha.1_5` → `dsh 0.1.6-alpha.1`。
 *
 * 发布 tag 是 `<dsh版本>_<修订号>`（见 server 的 image-catalog.ts）——修订号是平台
 * 自己的热修序号，对用户只是噪音，列表/卡片只写「dsh 0.1.6」这一层；完整引用
 * 进详情或 tooltip。取不到 tag 时原样返回，不硬凑前缀。
 */
export function dshVersionLabel(ref: string): string {
  const tag = imageTagOf(ref)
  if (tag === ref) return ref
  const cut = tag.lastIndexOf('_')
  const version = cut > 0 && /^\d+$/.test(tag.slice(cut + 1)) ? tag.slice(0, cut) : tag
  return `dsh ${version}`
}

/**
 * 下拉选项里的版本标：`dsh 0.1.6-alpha.1_5` —— 修订号**保留**：
 * 同一个 dsh 版本能有多条修订，省掉它两个选项就长一样了。取不到 tag 时原样返回。
 */
export function dshTagLabel(ref: string): string {
  const tag = imageTagOf(ref)
  return tag === ref ? ref : `dsh ${tag}`
}
