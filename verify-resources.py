"""Verify the fixed QQPet server resources using only the Python standard library."""
import argparse
import hashlib
import json
import re
import stat
import sys
from pathlib import Path


def resource_path(name):
    if not isinstance(name, str) or not name.startswith((
        'server/assets/', 'server/config/', 'server/resources/',
        'server/src/original-webdir/legacy-community-assets/',
    )):
        raise ValueError('清单含有素材目录以外的路径')
    for part in name.split('/'):
        if (not part or part.endswith(('.', ' ')) or re.search(r'[\\:<>"|?*\x00-\x1f]', part)
                or re.fullmatch(r'(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])', part.split('.')[0])):
            raise ValueError('清单含有无效的相对路径')
    return name


def inventory(rows):
    if not isinstance(rows, list) or not rows:
        raise ValueError('清单缺少素材记录')
    result = {}
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != {'path', 'size', 'sha256'}:
            raise ValueError('清单记录格式有误')
        name = resource_path(row['path'])
        key = name.casefold()
        if key in seen or type(row['size']) is not int or row['size'] < 0:
            raise ValueError('清单中有重复路径或无效大小')
        if not isinstance(row['sha256'], str) or not re.fullmatch(r'[0-9a-f]{64}', row['sha256']):
            raise ValueError('清单中的 SHA-256 无效')
        seen.add(key)
        result[name] = row
    return result


def split_inventory(manifest):
    if (not isinstance(manifest, dict) or manifest.get('format') != 2
            or not isinstance(manifest.get('baseline'), str) or not manifest['baseline']):
        raise ValueError('清单版本无效')
    groups = []
    for field in ('files', 'coreFiles'):
        rows = manifest.get(field)
        if not isinstance(rows, list):
            raise ValueError('清单缺少图形素材或运行文件分组')
        groups.append(inventory(rows) if rows else {})
    media, core = groups
    if not media and not core:
        raise ValueError('清单中没有文件')
    if {name.casefold() for name in media}.intersection(name.casefold() for name in core):
        raise ValueError('同一路径同时出现在素材与运行文件中')
    return media, core


def regular_file(root, name, directories):
    target = root / name
    parent = target.parent
    unchecked = []
    while parent != root and parent not in directories:
        if root not in parent.parents:
            raise ValueError('路径超出素材目录')
        unchecked.append(parent)
        parent = parent.parent
    for folder in reversed(unchecked):
        info = folder.lstat()
        if not stat.S_ISDIR(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('素材路径包含目录链接或无效目录')
        directories.add(folder)
    info = target.lstat()
    if not stat.S_ISREG(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
        raise ValueError('素材路径包含文件链接或非常规文件')
    return target


def check_file(root, row, directories):
    target = regular_file(root, row['path'], directories)
    if target.stat().st_size != row['size']:
        raise ValueError('大小不符')
    digest = hashlib.sha256()
    with target.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    if digest.hexdigest() != row['sha256']:
        raise ValueError('SHA-256 不符')


def main():
    parser = argparse.ArgumentParser(description='按本目录配套清单核对 r31 运行文件和图形素材。')
    parser.add_argument('root', type=Path, help='包含 server 子目录的源码根、服务端目录或单独素材目录')
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument('--core-only', action='store_true', help='仅检查随源码和服务端提供的运行文件')
    selection.add_argument('--media-only', action='store_true', help='仅检查单独提供的图形素材')
    args = parser.parse_args()
    manifest = Path(__file__).with_name('resources-manifest.json')
    root = args.root.resolve(strict=True)
    if not root.is_dir():
        raise ValueError('请指定包含 server 子目录的目录')
    data = json.loads(manifest.read_text(encoding='utf-8'))
    media, core = split_inventory(data)
    groups = []
    if not args.media_only:
        groups.append(('运行文件', core))
    if not args.core_only:
        groups.append(('图形素材', media))
    directories = set()
    failed = False
    for label, rows in groups:
        failures = 0
        for row in rows.values():
            try:
                check_file(root, row, directories)
            except (OSError, ValueError) as exc:
                if failures < 20:
                    reason = '缺失' if isinstance(exc, FileNotFoundError) else str(exc)
                    print(f"{reason}  {row['path']}", file=sys.stderr)
                failures += 1
        print(f"{data['baseline']}  {label} {len(rows) - failures}/{len(rows)} 项通过校验")
        failed |= failures != 0
    return int(failed)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f'无法校验素材：{error}', file=sys.stderr)
        sys.exit(2)
