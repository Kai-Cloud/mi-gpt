# 自定义语音后端桥接模式

此 fork 增加一个可选的 v4.2.0 运行时适配，主要用于对接 [lk-slc](https://github.com/LKChat/lk-slc) 项目的语音入口：小爱音箱 → MiGPT → OpenAI-compatible voice ingress → lk-slc bot → Agent。也可对接遵守同一协议的其他后端；默认模式不变。

职责边界：MiGPT 只提交当前问题并播报回答；lk-slc 负责请求关联与 bot 路由，Agent 负责原有人设、记忆和工具。会话采用独立模式还是复用已授权用户的既有会话，由后端可信配置决定，本仓不保存个人 Agent 名称、真实部署地址或用户映射。lk-slc 仓库若受访问权限限制，需要相应授权才能查看。

## 配置

以下是占位示例，请替换为音箱宿主实际可访问的地址、后端模型别名和凭据：

```dotenv
MIGPT_VOICE_BRIDGE=true
OPENAI_BASE_URL=https://voice-gateway.example.com/v1
OPENAI_API_KEY=REPLACE_WITH_YOUR_GATEWAY_KEY
OPENAI_MODEL=voice-agent
```

不要同时配置 `AZURE_OPENAI_API_KEY`，否则现有 wrapper 会选择 Azure 客户端。跨机器部署时，`localhost` 指向调用方自身，不是远端 Agent 所在主机。

启用后仅发送当前 `QueryMessage.text`，请求为一个 user message，`stream: true`；不带 MiGPT 人设、历史记忆、小爱原回答。跳过 MiGPT 的会话记忆初始化和两条内建人设修改命令，保留调用方自定义命令、音箱唤醒和 TTS；`client.start()` 原有数据库初始化仍存在。人设与持续对话由后端管理。

入口应支持 OpenAI SSE `choices[].delta.content` 和 `[DONE]`。该模式本身不增加搜索能力：后端是否配置可用搜索工具必须独立验证。

## 在现有官方镜像上部署

无需在线 build：将本仓 `app.js` 与 `voice-bridge.js` 放在受保护的宿主配置目录，为容器新增两个只读文件挂载：

```text
宿主/app.js          → /app/app.js          (只读)
宿主/voice-bridge.js  → /app/voice-bridge.js  (只读)
```

通过 `--env-file` 注入上述环境变量，保留现有 `.migpt.js` 只读挂载与 `.mi.json` 可写挂载。新增挂载和环境变量需要重建容器，单纯 restart 不够。备份旧配置并停止旧容器，不能同时运行两个实例监听同一音箱。

若自行构建，本仓 Dockerfile 和 .dockerignore 已包含新的运行时模块。

回退时改回原模型地址、密钥、模型名，关闭 `MIGPT_VOICE_BRIDGE` 后重建；不能只关闭开关却仍指向拒绝 system/history 的语音入口。

## 测试与验收

兼容性测试：

```bash
node --test tests/voice-bridge.test.mjs
```

测试依赖准备步骤见测试文件顶部；使用发布的 mi-gpt@4.2.0 bundle 和 openai@4.56.0 SDK，通过 loopback HTTP/SSE 验证真实请求格式。设备、持久化边界被替代，不会启动音箱或读取真实凭据。

实际部署时逐层验证：收到音箱识别文字、后端关联到正确请求、取得最终回答、发送播报，再由用户确认实际听到。只有容器 running 或后端 HTTP 200 不能证明完整语音链路成功。

回答长度、工具权限、超时与会话隔离由后端另行实现；本适配不提供通用权限沙箱。MiGPT 既有思考提示音/提示语也不属于后端最终答案。

凭据、Cookie、passToken、真实部署地址、个人 Agent 名称、真实配置和聊天数据库不能提交；日志转发前脱敏。
