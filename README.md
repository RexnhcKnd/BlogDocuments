# 文件站：用 GitHub 仓库给博客当文件库（纯网页操作，不需要命令行）

> 为什么不用 Cloudflare：实测你的网络 **`*.workers.dev` 不通**（TIMEOUT），CF 那套即使部署成功也访问不了，
> 还得买域名 + R2 绑卡。而 **github.com 网页、github.io、testingcf.jsdelivr.net 全部可达**，所以走这条。
>
> 又为什么不直接用公共文件床：实测 `catbox.moe` / `pixeldrain` / `tmpfiles` **连不上**，
> `0x0.st` **上传功能无限期关闭**，`uguu.se`（3 小时）/`litterbox`（72 小时）**文件会过期**——
> 没有一家能当博客的长期图床。

## 这个方案能给你什么

| 你想要的 | 能不能做到 |
|---|---|
| 上传各种格式 | ✅ 任意格式，单文件 < 100MB（GitHub）/ < 20MB（jsDelivr 直链） |
| 每个文件有链接 | ✅ `https://testingcf.jsdelivr.net/gh/用户名/BlogDocuments@main/files/文件名` |
| 外部直接链接 | ✅ 图片 `<img>`、视频 `<video>` 直接引（已实测：16 个文件全部 200，尺寸与本地一致） |
| 下载到本地 | ✅ 链接点开就是文件；目录页还有「下载」按钮 |
| 每个人都能上传 | ⚠️ 默认只有你能传。想让朋友也能传 → 仓库 `Settings → Collaborators` 加他们（最多几个），他们用 GitHub 账号网页上传即可 |
| 零成本 / 零部署 | ✅ 全程网页点几下，不装任何东西 |

## 操作步骤（全在网页上，照着点）

### 1. 注册 GitHub
https://github.com/signup → 用户名、邮箱、密码。（记下**用户名**，后面链接要用）

### 2. 新建仓库
右上角 `+` → **New repository** → 名字填 `BlogDocuments` → 选 **Public** → 点 **Create repository**
（不要勾 Add README，避免和待会儿传的文件冲突）

### 3. 网页拖拽上传
进入这个新仓库 → 点 **Add file** → **Upload files** → 打开本机的
`D:\deepseek harness\工作区\files-site\files\` 文件夹 → **把里面 16 个文件全选拖进网页** → 等进度条走完 → 点绿色 **Commit changes**

> 以后加文件就重复这一步：仓库首页 → Add file → Upload files → 拖进去 → Commit。

### 4. 拿直链
格式（把 `用户名` 换成你的）：

```
https://testingcf.jsdelivr.net/gh/用户名/BlogDocuments@main/files/bg_540p.mp4
```

点开就能下载/预览。**注意别用 `raw.githubusercontent.com` 的地址**——实测那个域名在你这网络不通。

### 5. 可选：生成一个"文件列表页"
本机跑一次（改了用户名之后）：

```powershell
cd "D:\deepseek harness\工作区\files-site"
# 先把 build-index.ps1 第 10 行的 $GH_USER 改成你的用户名
powershell -ExecutionPolicy Bypass -File .\build-index.ps1
```

生成的 `index.html` 会带搜索框和每个文件的「复制直链」按钮。把它也拖到仓库根目录，然后
仓库 **Settings → Pages** → Source 选 `main` + `/ (root)` → 保存，
过一分钟访问 `https://用户名.github.io/BlogDocuments/` 就是那个列表页。

### 6. 可选：让朋友也能上传
仓库 **Settings → Collaborators → Add people** → 填对方的 GitHub 用户名。
对方接受邀请后，用同样的「Add file → Upload files」就能传（**不需要**懂 git）。

## 已经帮你准备好的 16 个文件（在 `files/` 里，7.09MB）

| 文件 | 用途 |
|---|---|
| `bg_540p.mp4`（1.28MB）/ `bg_720p.mp4` | 壁纸视频，**所以那个"视频当博客背景"现在能做了** |
| `bg_static_2560.jpg` / `bg_article_2560.jpg` | 首页 / 文章页大图 2560×1440 |
| `bg_extra1~3.jpg` | 轮播用的另外三张画面 |
| `info_bg.jpg` | 侧边栏信息卡背景 |
| `snowflake.png` / `avatar_200.png` | 雪花 / 头像 |
| `whale_*.webp` / `whale_*.png` | 女仆装大肥鱼的三个状态（webp 小、png 备用） |

## 博客里怎么用

```html
<!-- 图片 -->
<img src="https://testingcf.jsdelivr.net/gh/用户名/BlogDocuments@main/files/bg_static_2560.jpg" alt="壁纸">

<!-- 视频 -->
<video src="https://testingcf.jsdelivr.net/gh/用户名/BlogDocuments@main/files/bg_540p.mp4" controls muted></video>

<!-- 下载 -->
<a href="https://testingcf.jsdelivr.net/gh/用户名/BlogDocuments@main/files/xxx.zip" target="_blank">下载 xxx.zip</a>
```

主题配置里当背景（`window.cnblogsConfig`）也一样，把相册地址换成上面的直链即可。

## 为什么域名是 testingcf.jsdelivr.net 而不是 cdn.jsdelivr.net

实测：`cdn.jsdelivr.net` 和 `fastly.jsdelivr.net` 在你这网络会 **301 跳到 `raw.githubusercontent.com`**，
而那个域名**不通**（ECONNRESET）——也就是说用默认域名的话，图片视频全都加载不出来。
换成 `testingcf.jsdelivr.net` 或 `testingcf.jsdelivr.net` 就正常（16/16 实测通过）。
**换节点只改域名，路径完全不变。**

## 节点可靠性实测（各 5 次）

| 节点 | 成功率 | 速度 | 说明 |
|---|---|---|---|
| `testingcf.jsdelivr.net` | **5/5** | 149–1507ms | **默认用这个** |
| `cdn.jsdelivr.net` | 5/5 | 66–103ms（最快） | 但文件未被 CDN 缓存时会 301 跳到**被墙的** raw.githubusercontent.com |
| `gcore.jsdelivr.net` | 4/5 | 100–884ms | 偶发 ECONNRESET |

三者都支持 Range 请求（视频能拖动播放，实测 206 + content-range 正确）。
**换节点只改 `build-index.ps1` 里 `$CDN_HOST` 那一行，重跑一次即可，路径不变。**

## 四个要记住的限制

1. **单文件 ≤ 20MB**（jsDelivr 的限制）。更大的只能找别的托管。
2. **jsDelivr 会长期缓存**：同一路径换了文件内容，可能还发旧的 → **改内容就换文件名**（`bg_v2.mp4`）。
3. **别用 Git LFS**：jsDelivr 不认 LFS 指针。
4. **中文文件名能用**，但建议用英文/拼音，链接更干净、也避免个别环境编码问题。

## 如果哪天还想要"陌生人也能上传"

那就得上 Cloudflare 那套（`filebox/` 里代码已经写好、31 项测试全绿）。但前提是先解决：
- `workers.dev` 在你这网络不通 → 需要**买一个域名**（~¥50/年）绑到 CF
- R2 开通可能要求**绑支付方式**

到那时再弄，我把每一步写成保姆级操作，你卡在哪一步截图问我。
