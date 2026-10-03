# filebox

一个跑在 **Cloudflare Pages Functions** 上的文件站：拖拽上传、文件列表、直链外链、下载、删除，
**不需要服务器、不需要数据库、不需要本地命令行**。

```
Cloudflare Pages（静态页面 index.html）
      └── Pages Functions（functions/api/[[path]].js）—— 4 个接口
                ├── ① GitHub Releases   免绑卡，总量与流量不限，单文件 ≤ 100MB  ← 推荐
                ├── ② R2 存储桶          免费 10GB，单文件可到 5TB，开通需绑支付方式
                └── ③ KV 命名空间        免费 1GB，单值 ≤ 25MB，免绑卡
```

三种存储**同一份代码都支持**，配了哪个就用哪个，切换不用改代码。

---

## 特性

| | 说明 |
|---|---|
| 上传 | 拖拽或点选，支持多选、任意格式，实时进度条；上传完**自动把直链复制到剪贴板** |
| 外链 | 图片/视频可直接内联引用（`<img>` / `<video>`），列表页的「引用」按钮直接生成代码 |
| 下载 | 每个文件带「下载」按钮（`?dl=1` 强制 `Content-Disposition: attachment`） |
| 删除 | 页面上直接删，需**删除密码**，带防爆破 |
| 权限 | 上传需**上传密码**；两个密码都在服务端 Secret 里，代码和仓库中不含明文 |
| 安全 | 危险类型强制下载 + `nosniff`、路径穿越清理、上传/删除双密码、按 IP 锁定 |
| 界面 | 深色、响应式、零依赖（单个 HTML，无框架无 CDN） |

## 文件结构

```
index.html                        整个前端（含样式和逻辑，零依赖）
functions/api/[[path]].js         整个后端（存储适配 + 4 个接口）
```

就这两个文件。放进任意 Cloudflare Pages 项目即可。

## 部署

### 1. 建一个 Pages 项目

把这两个文件按同样结构放进一个 GitHub 仓库（`index.html` 在根目录，后端放 `functions/api/`），
然后在 Cloudflare 控制台 **Workers & Pages → Create application → Pages → Connect to Git** 连上它。

构建配置：

| 字段 | 填什么 |
|---|---|
| Framework preset | **None** |
| Build command | **留空** |
| Build output directory | **`/`** |

> `functions/` 目录会被自动识别为 Pages Functions，不需要额外配置。

### 2. 选一种存储并配置

#### 方案 ①：GitHub Releases（推荐，免绑卡）

GitHub Releases 官方文档明确写着：**不限制 release 里二进制文件的总大小，也不限制分发带宽**。
所以拿它当文件存储不要钱、不要卡，而且文件不在 git 历史里，不占仓库体积。

1. 建一个**细粒度 token**：https://github.com/settings/personal-access-tokens/new
   - **Repository access** → `Only select repositories` → 只勾目标仓库
   - **Permissions → Repository permissions → Contents** → **`Read and write`**
   - 其余权限全部保持 `No access`
2. 在 Pages → **Settings → Environment variables** 加：

   | 名称 | 值 | 类型 |
   |---|---|---|
   | `GITHUB_TOKEN` | 刚生成的 `github_pat_...` | **Secret** |
   | `GITHUB_REPO` | `你的用户名/仓库名` | 变量 |

3. 重新部署（见下面「改环境变量后必须重新部署」）

上传的文件会以 **release asset** 的形式出现在该仓库的 Releases 里，
标签名由 `GITHUB_TAG` 决定（默认 `uploads`，首次上传时自动创建）。

#### 方案 ②：R2 存储桶

控制台 **R2 → Enable R2 → Create bucket**，然后在
**Pages → Settings → Functions → Bindings → Add → R2 bucket**，
变量名填 **`BUCKET`**，指向你的桶。

#### 方案 ③：KV 命名空间

控制台 **Workers & Pages → KV → Create namespace**，然后在
**Pages → Settings → Functions → Bindings → Add → KV namespace**，
变量名填 **`FILES`**。

> 优先级：**R2 > GitHub > KV**。想强制指定就设 `STORE` = `r2` / `gh` / `kv`。

### 3. 设置两个密码

**Pages → Settings → Environment variables**，两个都选 **Secret**、环境选 **Production**：

| 名称 | 作用 | 不配的后果 |
|---|---|---|
| `UPLOAD_PASSWORD` | 上传前必须输入 | **上传功能关闭**（谁都传不了） |
| `ADMIN_PASSWORD` | 删除前必须输入 | **删除功能关闭** |

两个密码是独立的，锁定状态各记一份，上传被锁不影响删除。

### 4. 改环境变量后必须重新部署

Cloudflare Pages 修改环境变量**不会自动重新部署**，跑着的实例仍用旧的环境。
改完必须去 **Deployments → 最新一条 → ⋯ → Retry deployment**，等状态变成 Success。

---

## 配置项

| 变量 | 默认值 | 说明 |
|---|---|---|
| `UPLOAD_PASSWORD` | — | 上传密码；未设置 = 上传关闭 |
| `ADMIN_PASSWORD` | — | 删除密码；未设置 = 删除关闭 |
| `SITE_NAME` | `文件站` | 页面标题 |
| `GITHUB_TOKEN` | — | 方案 ① 必需，细粒度 PAT |
| `GITHUB_REPO` | — | 方案 ① 必需，`用户名/仓库名` |
| `GITHUB_TAG` | `uploads` | Release 标签名 |
| `GITHUB_BRANCH` | `main` | 用于列出仓库里 `files/` 文件夹的分支 |
| `MAX_MB` | `100` | 单文件上限（MB），KV 模式自动夹到 25 |
| `STORE` | 自动 | 强制指定存储：`r2` / `gh` / `kv` |

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/list` | 文件列表 + 站点配置（上限、存储类型、是否需要密码） |
| `POST` | `/api/upload?name=<文件名>` | 上传，请求体就是文件本身；密码走 `X-Upload-Password` 请求头 |
| `GET` | `/api/file/<key>` | 下载/预览（危险类型强制下载）；`?dl=1` 强制下载 |
| `POST` | `/api/delete?key=<key>&password=<密码>` | 删除 |

上传密码放在请求头而不是 URL，避免密码进入访问日志和 Referer。

## 安全设计

| 措施 | 说明 |
|---|---|
| 危险类型强制下载 | `html/svg/js/exe/bat/php…` 一律 `Content-Disposition: attachment`，不会在站点域名下被当页面执行 |
| `X-Content-Type-Options: nosniff` | 防止浏览器把文件猜成别的类型执行 |
| 路径穿越防护 | 上传名只取最后一段并去掉控制字符（`../../../etc/passwd` → `passwd`） |
| 单文件大小上限 | 按 `content-length` 预判 + **落盘后再量一次复核**，分块上传也绕不过 |
| 双密码 | 上传、删除各一个；密码只存在于环境变量，仓库中无明文 |
| 防爆破 | 每个密码、每个 IP 连错 5 次锁 15 分钟；两套锁定互不影响 |
| 上传留痕 | 存储元数据里记录上传者 IP 与 UA |

## 存储方案对比

| | GitHub Releases | R2 | KV |
|---|---|---|---|
| 要绑卡 | 不用 | 可能要 | 不用 |
| 总量 | **不限** | 10 GB | 1 GB |
| 流量 | **不限** | 出口免费不限 | 读 10 万次/天 |
| 单文件 | 100 MB¹ | 5 TB² | **25 MB** |
| 单个容器上限 | 1000 个文件/Release | — | — |

¹ 受 **Cloudflare 账号套餐的请求体上限**限制（免费/Pro 100MB、商业 200MB、企业最高 5GB），
不是 GitHub 的限制（GitHub 单个 asset 可到 2GB）。突破它需要 R2 分片上传。
² 需配合分片上传；R2 单次 PUT 上限 5GB。

## 已知取舍

代码中标注 `ponytail:` 的位置是**有意为之的简化**，各有明确上限与升级路径：

- **文件列表最多取 1000 条**：R2 与 KV 都不翻页，GitHub 单 Release 本身也限制 1000 个 asset。
  超出时换 `GITHUB_TAG`，或给适配层补 cursor 循环。
- **GitHub 模式的密码锁定状态**存在一个下划线开头的隐藏 asset 里，
  每次「输错密码」会产生几次 API 调用（正常上传不触发写回）。频率很低，可接受。
- **GitHub 模式把 `request.body` 流式转给 GitHub**。若 GitHub 拒收 chunked 请求体，
  需要改成先 `await request.arrayBuffer()` 再传（代价是单文件会占用 isolate 内存）。

## 本地测试

```powershell
node _test/pagesfn3_test.mjs
```

用**内存版假 R2 / 假 KV / 假 GitHub API**（含 401、403、422、404 等真实行为）跑完整流程：

**R2 24 项、GitHub 26 项、KV 25 项，另加 GitHub 专属与 fail-closed 检查**，覆盖：

上传密码（空/错/正确/大小写/锁定/换 IP/不牵连删除）、下载内容与中文文件名还原、内联与强制下载、
列表字段、危险类型强制下载、路径穿越清理、两种大小超限、KV 上限夹取、
无密码时上传与删除关闭、GitHub 首次上传自动建 Release、asset 命名与 label 还原、
状态文件不重名、空仓库首次列表、配置缺失时的提示。

改完代码先跑这个，**全绿再部署**。
