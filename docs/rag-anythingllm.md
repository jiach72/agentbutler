# AnythingLLM 本地知识库与文档收集 (RAG) 运维与使用指南

本文档面向需要在 Agent Butler 中启用私有知识库的用户与智能体开发者。

---

## 1. 核心定位与技术架构

AnythingLLM 是 Agent Butler 推荐的轻量级开源（66k+ Stars）单容器知识库系统，主要解决**用户本地资料收集难、文档格式杂、智能体调用私有知识不便**的问题。

- **单容器极轻量**：仅一个 Docker 容器，无额外 MySQL / Redis / Elasticsearch 负担，空载内存约 300MB ~ 500MB；
- **嵌入式向量库**：内置 LanceDB 文件型向量存储，随 `anythingllm-data` 命名卷统一持久化；
- **本地 Ollama 直连**：自动利用 Butler 内部局域网中的 `http://ollama:11434` 获取 Embedding（如 `bge-m3`、`nomic-embed-text`）与大语言模型；
- **回环安全约束**：默认严格绑定 `127.0.0.1:3001`，未经授权不向局域网或公网暴露。

---

## 2. 启用与启停管理

### 方式 A：Web 控制台图形化管理（推荐）
1. 打开 Agent Butler 控制台；
2. 前往 **「设置 → API 密钥与服务 → 本地知识库 (RAG)」**（或直接点击侧栏 **「本地知识库」** 一级页面）；
3. 开启「开启本地知识库」开关，在弹出的二次确认对话框中点击「确认开启」；
4. 系统将记录开启状态，并在面板中展示运行与连接详情。

### 方式 B：终端命令行管理
在项目根目录下：

```bash
# 启动本地知识库容器
docker compose --profile rag-anythingllm up -d

# 查看运行状态
docker compose --profile rag-anythingllm ps

# 停止知识库容器（数据持久化保留，不丢失）
docker compose --profile rag-anythingllm stop butler-rag-anythingllm
```

---

## 3. 收集用户资料（资料入库流程）

1. **进入收集箱**：
   - 在 Agent Butler 侧栏点击 **「本地知识库」**，点击大按钮 **「打开资料收集箱」**（或直接在浏览器打开 `http://127.0.0.1:3001`）；
2. **创建工作区 (Workspace)**：
   - 首次进入可按业务或分类创建工作区，如 `公司资料`、`个人笔记`、`技术文档`；
3. **上传文档**：
   - 直接把文件拖拽进收集箱，支持的格式包括：
     - **电子书与文档**：PDF、Word (`.docx`)、PPTX、TXT
     - **技术文档**：Markdown (`.md`)、JSON、代码文件
     - **表格与数据**：CSV、Excel (`.xlsx`)
     - **互联网内容**：输入 URL 抓取在线文章、GitHub 仓库等
4. **切片与向量化**：
   - 勾选已上传的文件，点击「Move to Workspace」；AnythingLLM 会自动调用本地 Ollama 生成向量并完成索引。

---

## 4. 智能体 (Agent) 检索接入

Hermes 或 Butler 中的 Agent 可以在任务或对话中检索知识库内容。

### 步骤 1：获取 AnythingLLM API Key
1. 进入 `http://127.0.0.1:3001`；
2. 点击左下角齿轮「Settings」→「Developer Tools」→「API Keys」；
3. 点击「Generate New API Key」并复制生成的令牌；
4. 将该 Key 填入 `.env` 中的 `BUTLER_ANYTHINGLLM_API_KEY=`。

### 步骤 2：接口调用示例

#### REST 检索接口（针对指定工作区）
```bash
curl -X POST http://127.0.0.1:3001/api/v1/workspace/{workspace_slug}/chat \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "这份报告关于第三季度的营收总结是什么？",
    "mode": "query"
  }'
```

#### OpenAI 兼容格式接口
AnythingLLM 提供了与 OpenAI 完全兼容的端点，可直接作为 Hermes 的自定义模型或工具端点接入：
- **Base URL**: `http://127.0.0.1:3001/api/v1/openai/v1`
- **Model**: `workspace_slug`

---

## 5. 常见问题排查 (FAQ)

| 现象 | 原因分析 | 解决步骤 |
| :--- | :--- | :--- |
| **页面显示“等待知识库容器响应”** | 选项已开启但 Docker 容器未启动 | 执行 `docker compose --profile rag-anythingllm up -d` 启动容器 |
| **3001 端口冲突** | 宿主机已有其他进程占用了 3001 | 在 `.env` 中修改 `BUTLER_ANYTHINGLLM_PORT=3002`，然后重新 `up -d` |
| **文档向量化超时或失败** | 本地 Ollama 尚未下载 Embedding 模型 | 在 Butler「设置 → Ollama 本地模型」中拉取 `bge-m3` 或 `nomic-embed-text` |
| **关闭知识库后数据还在吗？** | 数据保存在命名卷中 | 数据保存在 `anythingllm-data` 卷中，重启或升级均不会丢失 |
