/**
 * 一个普通文件的 ustar。给命名卷退路用：辅助容器看不到宿主路径，只能把归档解进挂载点。
 * 名字不许带目录，避免解进卷外。
 */
export function singleFileTar(name: string, data: Buffer, mode: number, uid: number, gid: number): Buffer {
  if (
    name.length === 0 || name.length > 100 || name.includes('/') || name.includes('\0') ||
    name === '.' || name === '..'
  ) {
    throw new Error('tar 文件名不合法')
  }
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new Error('tar 元数据不合法')
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid < 0 || gid < 0) {
    throw new Error('tar 元数据不合法')
  }

  const header = Buffer.alloc(512)
  header.write(name, 0, name.length, 'utf8')
  writeOctal(header, mode, 100, 8)
  writeOctal(header, uid, 108, 8)
  writeOctal(header, gid, 116, 8)
  writeOctal(header, data.length, 124, 12)
  writeOctal(header, 0, 136, 12)
  header.fill(0x20, 148, 156)
  header[156] = 0x30
  header.write('ustar', 257, 5, 'ascii')
  header[262] = 0
  header.write('00', 263, 2, 'ascii')

  let sum = 0
  for (let i = 0; i < 512; i++) sum += header[i] ?? 0
  const digits = sum.toString(8).padStart(6, '0')
  header.write(digits, 148, 6, 'ascii')
  header[154] = 0
  header[155] = 0x20

  const pad = (512 - (data.length % 512)) % 512
  return Buffer.concat([header, data, Buffer.alloc(pad + 1024)])
}

function writeOctal(header: Buffer, value: number, offset: number, length: number): void {
  const digits = value.toString(8).padStart(length - 1, '0')
  if (digits.length !== length - 1) throw new Error('tar 字段放不下')
  header.write(digits, offset, length - 1, 'ascii')
  header[offset + length - 1] = 0
}
