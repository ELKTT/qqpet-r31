"""Pair a player-owned local r31 client (HTTP 80, directory TCP 443) with a new login certificate."""

import argparse
import hashlib
import json
import re
import shutil
import stat
from pathlib import Path
from uuid import uuid4


BASELINE = "qqpet-complete-20261022-mainline-r31"
ORIGIN = "https://127.0.0.1:18443"
LOGIN = "QQPetAgent/client-login.json"
STATE = "QQPetAgent/package-state.json"
# Digest of the verified loopback 80/443 package state with a neutral login-certificate row.
LOCAL_STATE_SHA256 = "461c800a7a0c79d7ac7acdd37241e40706f3f5eaea17b125031a626b6f8e1d0f"


def regular_path(root, name):
    path = root
    for part in Path(name).parts:
        path = path / part
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("客户端固定文件的路径中含有链接。")
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("客户端缺少清单指定的普通文件。")
    return path


def read_limited(path, limit):
    with path.open("rb") as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError("配置文件超过预期大小。")
    return data


def login_profile(raw):
    value = json.loads(raw)
    if (not isinstance(value, dict) or set(value) != {"schemaVersion", "loginOrigin", "certificateSha256"}
            or type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1
            or value["loginOrigin"] != ORIGIN or not isinstance(value["certificateSha256"], str)
            or not re.fullmatch("[0-9a-f]{64}", value["certificateSha256"])):
        raise ValueError("请选择由本机 r31 服务端生成的 client-login.json。")
    return raw


def local_state(root):
    state = json.loads(read_limited(regular_path(root, STATE), 3 * 1024 * 1024))
    if (not isinstance(state, dict) or state.get("baseline") != BASELINE
            or state.get("part") != "client" or state.get("ip") != "127.0.0.1"
            or state.get("webPort") != 80 or state.get("directoryPort") != 443):
        raise ValueError("需要已配置为本机 127.0.0.1、HTTP 80 和社区目录 TCP 443 的 r31 客户端。")
    rows = state.get("files")
    if (not isinstance(rows, list) or len(rows) != 9162
            or any(not isinstance(row, dict) or not isinstance(row.get("path"), str) for row in rows)):
        raise ValueError("客户端固定文件清单不完整。")
    logins = [row for row in rows if row["path"] == LOGIN]
    if len(logins) != 1 or set(logins[0]) != {"path", "sha256", "size"}:
        raise ValueError("客户端登录配置记录有误。")
    # Only the paired certificate is installation-specific. Verify the entire fixed
    # inventory before opening any source file named by the inventory.
    neutral = [({"path": LOGIN} if row["path"] == LOGIN else row) for row in rows]
    canonical = json.dumps({**state, "files": sorted(neutral, key=lambda row: row["path"])},
                           ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    if hashlib.sha256(canonical).hexdigest() != LOCAL_STATE_SHA256:
        raise ValueError("客户端清单与已核对的 r31 本机 80/443 版本不符。")
    old_profile = login_profile(read_limited(regular_path(root, LOGIN), 2048))
    if (logins[0]["size"] != len(old_profile)
            or logins[0]["sha256"] != hashlib.sha256(old_profile).hexdigest()):
        raise ValueError("原客户端的登录配置与其完整性清单不一致。")
    return state, logins[0]


def copy_checked(source, destination, row):
    digest = hashlib.sha256()
    size = 0
    with source.open("rb") as src, destination.open("xb") as dst:
        for chunk in iter(lambda: src.read(1024 * 1024), b""):
            size += len(chunk)
            if size > row["size"]:
                raise ValueError(f"客户端文件大小不符：{row['path']}")
            digest.update(chunk)
            dst.write(chunk)
    if size != row["size"] or digest.hexdigest() != row["sha256"]:
        raise ValueError(f"客户端文件校验失败：{row['path']}")


def pair(source, profile, destination):
    if not source.is_dir() or source.name.isdecimal():
        raise ValueError("请选择与本机 80/443 端口匹配的客户端根目录。旧版 18080/18444 的 client.zip 不适用。")
    root_info = source.lstat()
    if stat.S_ISLNK(root_info.st_mode) or getattr(root_info, "st_file_attributes", 0) & 0x400:
        raise ValueError("请选择真实客户端目录。")
    source = source.resolve(strict=True)
    parent = destination.parent.resolve(strict=True)
    output = parent / destination.name
    if not parent.is_dir() or output.exists() or output.is_symlink() or output.is_relative_to(source):
        raise ValueError("请选择原客户端以外的新目录，且父目录须已存在。")
    new_profile = login_profile(read_limited(profile, 2048))
    state, login = local_state(source)
    stage = parent / (".qqpet-pair-" + uuid4().hex)
    stage.mkdir()
    try:
        for row in state["files"]:
            name = row["path"]
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if name == LOGIN:
                target.write_bytes(new_profile)
            else:
                copy_checked(regular_path(source, name), target, row)
        login.update(size=len(new_profile), sha256=hashlib.sha256(new_profile).hexdigest())
        (stage / STATE).write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n",
                                  encoding="utf-8", newline="\n")
        (stage / "launcher.ini").write_bytes(b"[Launcher]\r\nAutoLogin=0\r\n")
        if output.exists() or output.is_symlink():
            raise FileExistsError("输出目录已存在。")
        stage.rename(output)
    finally:
        if stage.exists() and stage.resolve().parent == parent and not stage.is_symlink():
            shutil.rmtree(stage)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("client_directory", type=Path)
    parser.add_argument("client_login", type=Path)
    parser.add_argument("new_directory", type=Path)
    args = parser.parse_args()
    try:
        pair(args.client_directory, args.client_login, args.new_directory)
    except (OSError, TypeError, ValueError) as error:
        parser.exit(1, str(error) + "\n")
    print("已生成配对客户端：", args.new_directory)
