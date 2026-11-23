# 登录程序与客户端补丁

## 自行准备客户端文件

本目录提供项目自写的 Windows 登录器、构建脚本和补丁代码。运行游戏时，玩家需自行收集有权使用的 r31 配套客户端程序、登录皮肤、宠物动作、游戏与场景 SWF、Flash 组件和原生插件，并保留其客户端目录结构。

本版本要求客户端和服务端位于同一台机器。客户端须使用 `127.0.0.1` 的 HTTP 资源端口 `80`、社区目录 TCP 端口 `443` 和 HTTPS 登录端口 `18443`。可核对自备客户端的 `QQPetAgent/package-state.json` 中的 `ip`、`webPort`、`directoryPort`，以及 `QQPetAgent/client-login.json` 中的登录地址和证书指纹。前者须与实际安装文件一致，后者须与本机服务端配对。

## 配对本机客户端

按[服务端安装说明](../README.md)完成本机初始化后，仓库根目录会生成 `client-login.json`。准备一份配置为 `127.0.0.1`、资源端口 `80` 和社区端口 `443` 的 r31 客户端。关闭该客户端，在仓库根目录执行以下命令，将两个示例路径改为本机实际位置。

```powershell
python client/pair-client.py "D:/Games/QQPet-r31-local80" client-login.json "D:/Games/QQPet-paired"
```

第一项路径是已有 `QQ宠物.exe` 和 `QQPetAgent/package-state.json` 的客户端根目录，最后一项是原客户端以外尚未创建的新目录。脚本先核对固定清单，再逐文件检验并复制其中的 9,162 项，写入本机登录证书配置及相应摘要。配对后的客户端采用手动登录。启动本机服务端后，从新目录运行 `QQ宠物.exe`。

## 识别旧端口归档

原始 r31 `client.zip` 使用资源端口 `18080` 和社区目录端口 `18444`。单独更换登录证书，资源下载和社区目录仍会访问旧端口。这份归档无法用于上面的 `80/443` 客户端配对。可在 PowerShell 中用 `Get-FileHash -Algorithm SHA256 'D:/Downloads/client.zip'` 识别旧归档，其整包 SHA-256 为

```text
ba0f6b82fce1cf5ed3eea2b922c899d002859a4707599ccd1523849605bff155
```

## 编译登录程序

在 Windows 上使用 .NET Framework 4.x 的 32 位编译器 `csc.exe`。在公开源码根目录打开 PowerShell，运行

```powershell
.\client\build-login.ps1
```

生成两个 x86 程序。根入口 `client/build/QQ宠物.exe` 由 `tools/feedback-release-20261016/DirectEntry.cs` 和完整配置校验代码编译，负责核对并打开 `client/build/QQPetAgent/QQPetAgent.exe`。如需再次编译，可用 `-OutputDirectory` 指定新目录。七份 C# 源文件位于 `tools/local-login/`，包含登录面板、透明窗口、证书指纹验证、登录偏好、Flash 宿主和完整客户端校验。构建沿用编译器默认图标。

登录器实际运行需要相应的 QQPenguin、登录皮肤、Flash 控件及其应用清单、原生桥接模块和本服的登录配置。玩家配对后的客户端已经具备这些依赖。`QQPetAgent/package-state.json` 登记的登录入口是 `QQPetAgent/QQPetAgent.exe`。本地编译的程序与该清单登记的哈希不同，请保留包内的登录器供玩家使用。

## 源码和成品素材

本目录收录首次启动版本修复、社区与家园消息框定位、窗口名读写的补丁源码。客户端使用的成品 SWF 包含宠物动作、游戏和场景美术。玩家自行准备与 r31 匹配的成品文件后，可用下方脚本检查窗口补丁。项目有权授权的登录器和补丁源码采用 PolyForm Noncommercial License 1.0.0，供非商业使用。第三方客户端组件和素材依各自原有授权使用。[许可证全文](../LICENSE)

## 核对窗口定位补丁

社区、家园和消息框沿用同一套提示框定位逻辑。`tools/community-entry-r29-20261018/window-placement.mjs` 生成窗口定位代码，`shared-name.mjs` 生成窗口名读写代码。在源码根目录用 Node.js 24 运行下列命令，可查看两份补丁代码的 SHA-256

```sh
node client/check-window-patch.mjs
```

要核对自己持有的 r31 客户端，把 QQPenguin 目录作为参数。脚本在四个指定 SWF 中逐一比对两段编译结果，逐文件输出 `OK`。检查只读取文件，无需启动 Flash 或游戏。

```powershell
node client/check-window-patch.mjs 'D:/Games/QQPet-local/QQPenguin'
```

## 首次启动版本记录

`tools/complete-release/ClientState.ps1` 按配套客户端的插件目录和已安装资源清单生成首次启动所需的版本记录。在 PowerShell 中可先检查手中的客户端副本

```powershell
. .\tools\complete-release\ClientState.ps1
Initialize-QQPetInstalledState -ClientRoot 'D:/Games/QQPet-local/QQPenguin' -CheckOnly
```

移除 `-CheckOnly` 后会在该副本内创建缺失的 `pluginversion.ini` 和 `LocalVersion.ini`。已存在的记录会保留。
