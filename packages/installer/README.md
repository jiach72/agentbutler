# Agent Butler Installer

从 npm 或本地构建启动安装器：

```bash
npx agent-butler --form docker
npx agent-butler --form host
```

Windows 原生环境推荐 Docker Desktop 或 WSL。Hermes 的宿主进程安装需要 Bash、Python 和 Linux/WSL 运行时；在原生 Windows 上安装器会停止并给出下一步，不会假装已经安装成功。

常用维护命令：

```bash
agent-butler reset --yes       # 停止服务并清空 Butler 本地状态（保留仓库）
agent-butler uninstall --yes   # 停止服务、移除用户服务和 Butler 本地状态
```

不带 `--yes` 时只会显示将要执行的动作。
