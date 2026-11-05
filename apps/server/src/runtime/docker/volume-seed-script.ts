/**
 * 命名卷辅助容器里、解 tar 之前跑的准备脚本。
 *
 * 只认两个相对路径：凭据文件，以及 `profiles/web/cordis.patch.yml`。
 * 父目录不存在就建；任一路径分量是符号链接就停。目标已存在（含符号链接）则退出 3，
 * 调用方据此跳过，不再解包。脚本不接收文件正文，避免 Key 进 argv。
 *
 * 退出码：0 可以写；2 路径不在白名单；3 目标已在；4 父级不是可创建的真实目录。
 */
export const VOLUME_SEED_PREPARE_SCRIPT = [
  'root=$1',
  'rel=$2',
  'case "$rel" in',
  '  .credentials.yaml) ;;',
  '  profiles/web/cordis.patch.yml) ;;',
  '  *) exit 2 ;;',
  'esac',
  'case "$rel" in',
  '  */*)',
  '    file=${rel##*/}',
  '    dirrel=${rel%/*}',
  '    ;;',
  '  *)',
  '    file=$rel',
  '    dirrel=',
  '    ;;',
  'esac',
  'parent=$root',
  'if [ -n "$dirrel" ]; then',
  '  oldifs=$IFS',
  '  IFS=/',
  '  for part in $dirrel; do',
  '    [ -n "$part" ] || exit 2',
  '    case "$part" in',
  '      .|..) exit 2 ;;',
  '    esac',
  '    parent=$parent/$part',
  '    if [ -L "$parent" ]; then exit 4; fi',
  '    if [ -d "$parent" ]; then',
  '      continue',
  '    fi',
  '    if [ -e "$parent" ]; then exit 4; fi',
  '    mkdir "$parent" || exit 4',
  '    chmod 0750 "$parent" || exit 4',
  '  done',
  '  IFS=$oldifs',
  'fi',
  'target=$parent/$file',
  'if [ -e "$target" ] || [ -L "$target" ]; then exit 3; fi',
  'exit 0',
].join('\n')
