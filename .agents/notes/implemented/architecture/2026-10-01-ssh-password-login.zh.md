# Agent Note: SSH password login

Status: implemented

[English](2026-10-01-ssh-password-login.md) | 中文

## 问题

添加 SSH 工作区原先需要一个 OpenSSH 别名，也就是说，人必须先改 `~/.ssh/config` 并持有密钥，才能添加远端机器。只有 `用户@主机` 和密码的人用不了。[POSIX SSH 决策](2026-09-11-posix-ssh-runtime.zh.md)为每个 ssh 子进程固定了 `BatchMode=yes` 和严格的主机密钥检查；同一个主机字符串还流入 Session 头部、工作区注册表、SQLite 目录、科研环境和实验运行器，所以第二种登录方式必须覆盖每一个启动 `ssh` 的位置，同时不改变任何持久化格式。

## 决策

已保存密码的主机用密码登录；其他主机的密钥、认证代理和 ssh 配置路径保持不变。选择在添加工作区时做出，并以"是否存在已保存的密码"体现，而不是作为一个字段。

**主机字符串。** 持久化的 `host` 仍是一个字符串：别名、`用户@主机`，或二者之一后接 `:端口`。`parseSshHost` 拆出端口，`sshDestinationArguments` 在最后一刻生成 `-p 端口 主机`，所以工作区记录、Session 头部、`workspaceLocationKey`、目录和格式校验器都保持原有形状，无需迁移。科研环境的 `sshHost` 必须与工作区的字符串相同，远程运行就是这样找到同一个密码的。

**Askpass。** ssh 子进程只在自己的环境里得到 `SSH_ASKPASS`、`SSH_ASKPASS_REQUIRE=force` 和 `DSH_SSH_ASKPASS_SECRET`。askpass 程序不含任何密钥：POSIX 上是一个 `sh` 脚本，Windows 上是 `askpass.cmd` 运行 Windows PowerShell 中的 `askpass.ps1`，位于每个进程创建一次、退出时删除的私有目录中。密钥不经过 `cmd.exe` 的解析，不进入任何参数，PowerShell 以 UTF-8 字节写出。确认类提示（`SSH_ASKPASS_PROMPT=confirm`）一律拒绝。密码登录的选项是 `BatchMode=no`、`NumberOfPasswordPrompts=1`、`PubkeyAuthentication=no` 和 `PreferredAuthentications=password,keyboard-interactive`：密码错误约半秒内失败，加密的默认密钥也不会被登录密码去回答。`StrictHostKeyChecking=yes` 和 `ForwardAgent=no` 保留。密钥登录的参数向量保持原样。

**Windows 的限制，在 OpenSSH_for_Windows_8.6p1 上实测。** `SSH_ASKPASS_REQUIRE=force` 有效。`.cmd` 形式的 askpass 能运行；`.js` 文件或任何不可执行文件会以 CreateProcess 错误 193 失败。含非 ASCII 字符的路径会以错误 2 失败，空格则没有问题，所以目录取临时目录、`ProgramData`、`Users\Public` 中第一个纯 ASCII 的位置。在 `.cmd` 里用 `%VAR%` 展开密码会被 `cmd.exe` 解析，因此改用 PowerShell。Windows 没有 ControlMaster，所以每条流都要重新认证。

**版本门槛。** `ssh -V` 必须报告 OpenSSH 8.4 或更新版本，`SSH_ASKPASS_REQUIRE` 自该版本引入；更旧或无法识别的客户端在连接之前就以 `unsupported` 失败，因为它可能改为在启动 Harness 的终端上提示。

**存储。** 密码是 `credentials` 的一条 `api-key` 类记录，地址为 `ssh/host-<主机的 sha-256，32 位十六进制>`：与其他凭据同一个文件、同样的保护，即操作系统用户自己的文件权限。在 Windows 上这是用户配置目录的访问控制列表，不是加密，该用户的进程可以读取。哈希后的键让文件不会列出人用过的主机。Workspace 记录、Session 头部、事件、响应或错误中都不含密码。Remote 请求只携带它一次，从对话框到 `remoteWorkspacePresets.inspect`，后者先验证，主机接受之后才保存，所以输错的密码不会覆盖一个能用的密码。之后选择密钥登录再添加会忘掉它，删除某主机的最后一个工作区也会忘掉它。

**失败。** `classifySshFailure` 读取 ssh 自己的措辞，且区分大小写，所以远端的 `EACCES: permission denied` 不会被当成登录失败，结果为 `auth`、`unreachable`、`host-key`、`host-key-changed` 或 `unsupported`。`SshFailure` 带着该类别，以及去掉密码后的最后一行诊断作为消息。工作区控制器把它映射为 `workspace/ssh-failed`，原因放在 details 中，对话框用读者的语言表述每种原因。未知的主机密钥仍然是失败：消息告诉人运行一次 `ssh` 并回答 yes。

## 考虑过的替代方案

**把密码放进参数，或使用 `sshpass`。** 参数对该用户的所有进程可见，而 Windows 上没有 `sshpass`。

**驱动伪终端提示。** 需要终端模拟依赖，在 Windows 上行为不同，提示文本一变就失效。`SSH_ASKPASS` 是 OpenSSH 自己的非交互通道。

**对密码主机用内嵌的 SSH 库代替系统 `ssh`。** 这会把传输一分为二，丢掉 `ssh_config` 语义和控制主连接，还给辅助程序的流设计增加原生依赖。

**给 `WorkspaceLocation` 增加 `user`、`port` 和 `authKind` 字段。** 读起来更清晰，但该位置被持久化在工作区记录、只接受两个键的 Session 头部校验器、SQLite 目录以及 v4 到 v5 的格式迁移中。为一个展示层面的需求做相邻格式迁移不值得。字符串编码不改动其中任何一个。代价是侧栏标签会显示成 `用户@主机:2222:/路径`。

**用 `StrictHostKeyChecking=accept-new` 信任未知主机密钥。** 它会信任首次连接看到的任何密钥，人没有看过指纹。更好的设计是对话框中增加一步，显示指纹并把密钥追加到 `known_hosts`，但尚未实现；它需要第二次携带人所确认指纹的 Remote 往返。

**操作系统钥匙串。** Windows 凭据管理器或 DPAPI 需要原生插件和新的凭据提供方。[credentials-local README](../../../../packages/credentials/credentials-local/README.zh.md#known-limitations-and-deferred-work)已经把该提供方延后，而且无论哪种方式，Agent 的工具进程都以同一个用户运行。

**用"每次会话询问"代替保存。** 重启后恢复会话时，需要在打开过程中途弹出密码提示。保存是让恢复可用的最小设计；对话框会直白地说明密码保存在哪里。

**用文件或命名管道把密钥交给 askpass。** 文件需要在 Windows 每条流各自登录期间管理生命周期，管道则每次启动都需要一个服务端。只存在于一个子进程中的环境变量是仍然简单的最窄暴露面。

## 后果

人可以添加 `用户@主机` 加密码，而所有密钥、认证代理和 ssh 配置的流程保持不变。密码暴露给同一用户的进程，途径是凭据文件和正在运行的 ssh 子进程的环境；它没有加密，对话框、用户指南和各包 README 都如实说明。Windows 上每条流要多花约 0.3 秒和一次 PowerShell 启动。删除某主机的最后一个工作区会删除它的密码，所以该工作区下已归档的会话需要先重新添加工作区才能恢复。首次出现的主机密钥仍需要手动 `ssh` 一次；对话框会告诉人该运行哪条命令。

[POSIX SSH 决策](2026-09-11-posix-ssh-runtime.zh.md)仍然拥有传输；本笔记增加登录方式，并不取代它。

## 验证

单元测试断言：在辅助进程启动、每条 Windows 流、设置命令和实验运行器中，密码不在任何参数向量、错误文本或返回输出里，已分类的失败也绝不含有它。测试在宿主平台上真实运行所生成的 askpass 程序，密码为 `pässwörd测试 &%^"'x!`。一次手动运行用真实的方案和真实的 OpenSSH_for_Windows_8.6p1 连接本地仅支持密码的测试服务器：正确密码约 0.3 秒成功，错误密码约 0.5 秒后以 `auth` 失败，未知与已变更的主机密钥分别以 `host-key` 和 `host-key-changed` 失败，被拒绝的端口以 `unreachable` 失败。尚未对原生 `sshd`、Linux 或 macOS 客户端、完整组合的产品配置做过测试。
