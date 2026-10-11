# dsh-priestess-companion · 普瑞赛斯挂件

她悬浮在 DSH 网页最上层，身旁一行浅白色的 DeepSeek 余额。按住她可以拖到任何地方，
松手后位置会被记住，刷新页面仍在原处。

- **不会被遮挡**：她住在 `shell.overlay`——整帧最上层的浮动层，聊天框、侧栏、输入框都盖不住她。
- **不挡路**：那一层本身是点击穿透的，只有挂件自己重新打开了指针事件；不拖她的时候，她挡不住下面的应用。
- **图不变形**：宽度由 `scale` 给，高度一律 `auto`。
- **容器无背景**：她是抠图，垫一层底色等于白抠。

## 目录结构

```
dsh-priestess-companion/
├── package.json          插件清单（DSH 用它的 dsh 字段，见下方说明）
├── cordis.patch.yml      装载层：把本插件插进 profile 的配置树
├── index.js              宿主半：余额路由 + 图片路由
├── client.js             客户端半：悬浮挂件本体（含全部样式 + 内联语音）
├── assets/
│   └── priestess.png     挂件实际加载的人物图（透明底 PNG，460×518）
├── voices/
│   └── line-01.wav       点击她时播放的语音（归档用，见下）
├── source/
│   ├── artwork-1280.jpg  原始立绘（博士提供的那张）
│   ├── cutout-1280.png   全尺寸抠图（1280×1280 透明底）
│   └── NOTES.md          素材溯源与再生成方式
├── locale/
│   ├── zh.json           展示用的标题与详细描述（中文）
│   └── en.json           同上（英文）
├── icon.svg              插件管理页里显示的图标
├── inject_voice.py       把语音内联进 client.js 的小工具
└── README.md
```

### 素材都在包里，但语音是"归档"

`assets/` 是运行时真正读的图；`source/` 与 `voices/` 是**素材归档**，运行时**不读**它们。

尤其注意语音：它是通过 `inject_voice.py` **内联进 `client.js`** 的（base64 data URL），
所以**改 `voices/line-01.wav` 不会改变播放内容**——要换语音必须重跑那个脚本。为什么这么绕，
见下方"点击她"一节。`source/NOTES.md` 记着每个素材的来源与哈希。

### 关于 manifest.json

DSH 插件**不使用 manifest.json**。它的等价物是两处：

| 传统清单里的东西 | 在 DSH 里写在哪 |
|---|---|
| 包名 / 版本 / 入口 | `package.json` 的 `name` / `version` / `main` / `exports` |
| 插件声明、要挂载什么 | `package.json` 的 `dsh` 字段（`bundle.patch` 指向装载层，`client` 声明这是网页端插件） |
| 装载与配置默认值 | `cordis.patch.yml` |
| 展示名 / 描述 / 图标 | `package.json` 的 `meta` 与 `icon`，**以及 `locale/{zh,en}.json` 里的 `meta`** |

### 展示元信息写两处

`readPluginMeta` 会同时读 `<包名>/locale/en.json` 与 `<包名>/package.json`，所以
**描述在两处都写了一份**，不依赖它最终读哪一个。改描述时两份都要改（见
`package.json` 里那条 `//` 注释）。

配 `locale/` 的两个前提（漏了就会静默不显示）：

1. `exports` 必须暴露 `"./locale/*.json": "./locale/*.json"`；
2. `files` 里要有 `locale/*.json`（打包安装时才带得走，link 安装不影响）。

**图标** `icon.svg` 是一个 64×64 的深蓝黑圆角方块，中间一枚亮紫菱形（她的瞳孔）加竖缝，
左右各一道品红/青的色偏描边。加底板是为了在浅色主题的插件列表里也读得出来。

客户端半也**没有独立的 HTML 文件**：它是一个模块（`client.js`），由页面的模块加载器
`window.__ModuleLoader__.load({ id, factory })` 载入，样式以 `<style>` 元素随组件挂载，
卸载时一并消失。所以"js / html / css 三件套"在这里是"一个模块 + 内联样式"。

## 图片资源放在哪

`assets/priestess.png`，通过宿主路由 `GET /dsh-priestess-companion/image` 供出去
（浏览器读不到本地路径，图片必须由宿主发）。

**换图有两种方式**：

1. 直接替换 `assets/priestess.png`（保持透明底 PNG）。路由带 ETag，内容一变自动失效，**不用重启**。
2. 改配置 `image`：填包内相对路径、绝对路径，或一个 `https://…` 地址。填远程地址时页面直接去取，不走宿主。

当前这张图来自 `priestess_cutout3/`（白底那张 1280×1280），抠出后缩到 460px 宽（460×518）。
边缘用的是 **rembg 的 u2net + alpha matting**，不是阈值——白底抠图那圈"白色破碎毛边"
只有 matting 能收拾（详见该目录的 `matte.py` 与 `run_rembg.py` 对照）。

**白底的抠法与暗底完全不同**：她的手背与袖口本身就是 0.92–0.98 的白，按亮度一刀切会把
手削掉。所以判据不是"白不白"，而是**连通性**——只有与画面外沿相连的白色才算背景，被她
轮廓围在里面的浅色一律留下（`cutout.py` 的"从边界灌水"）。另外**不能平滑**：她的轮廓线
细到 1–2px，σ=1.5 一糊就把它抬到白底之上，白色会顺着灌进手背。

## 余额从哪来 / 怎么换成你的 API

宿主半有**三种来源**，由配置 `source` 选：

| `source` | 含义 | 相关配置 |
|---|---|---|
| `account`（默认） | 读 DSH 自己的 DeepSeek 账号钱包 | 无 |
| `url` | 去问任意 HTTP 接口，返回的数字或 JSON 都认 | `url` |
| `fixed` | 写死一个数字，纯粹用来试样式 | `fixedValue`、`fixedSymbol` |

**换成你自己的接口**（改 `cordis.patch.yml` 即可，不必动代码）：

```yaml
- id: priestess-companion
  name: dsh-priestess-companion
  config:
    source: url
    url: http://127.0.0.1:8080/api/balance
```

接口返回下面任何一种都会被认出来：

```jsonc
12.34                             // 裸数字
"12.34"                           // 字符串数字
{ "balance": "12.34" }            // balance / total / amount / remaining / available
{ "data": { "balance": 12.34 } }  // 再往下一层也行（最多两层）
```

字段名不在这几个里，就在 `index.js` 的 `pickNumber()` 里往 `KEYS` 加一个：

```js
const KEYS = ['balance', 'total', 'amount', 'remaining', 'available', '你的字段名']
```

**要在代码里直接留一个余额变量**，用 `fixed` 来源最简单：
`config: { source: fixed, fixedValue: '88.88', fixedSymbol: '¥' }`。

## 数字的样式（跟着素材走）

现在的数字是**黑紫粗体 + 菱形前缀**：`color: rgba(20,12,34)` 读起来是黑的，色调却归她
（黑发、菱形紫瞳）；前面那个 `◆` 是刻意的署名，字体加粗到 700。字外面垫了一圈**薰衣草白
的柔光**——页面底色可深可浅，纯黑字在深色底上会消失，白晕是让它两边都读得清的唯一办法。

这套样式是**按素材定的**，换素材时要一并回看：
- 网点故障画 → 品红/青分色边 + 随机闪断；
- 冷蓝窗光画 → 两层冷光 + 缓慢呼吸；
- 白底立绘（现在这张）→ 黑紫粗体 + 白晕 + 菱形，人物图的滤镜也从"色边/蓝晕"换成中性淡影。

**换素材时请一并回看这些**：与素材绑定的效果（filter / text-shadow / 动画）是跟着
画风走的，只换路径不重看效果，就会得到"新画配旧皮肤"的违和。

## 人物周围那层灰影

`client.js` 里 `.pw-img` 的 `filter`：

```css
filter: drop-shadow(0 0 10px rgba(126, 130, 140, 0.55))
        drop-shadow(0 0 26px rgba(126, 130, 140, 0.34));
```

- **为什么是灰不是黑**：她的衣服本身就是浅色，黑影在浅底上会把她切出一道硬边、在深底上
  又完全看不见；中灰两头都成立。
- **为什么是两层**：一层贴着轮廓（近而稍浓）给体积，一层铺开（远而更淡）给过渡。只用一层
  不是"描边"就是"糊"。
- **调哪里**：两个 `rgba` 的最后一位是透明度，数值越大影越浓。这个文件是**客户端半**，
  改完**刷新页面**生效。

## 文字的位置

整支挂件是**横排、顶端对齐**（`.pw-root { align-items: flex-start }`），文字栏再从顶端
往下推 **20% 的图高**（`marginTop: scale * 0.20`）——她的头大约占图的上四分之一，所以数字
正好落在她头部右侧。用**比例**而不是固定像素：`scale` 一改，文字仍跟着头走。

## 点击她 → 随机播一条语音 + 浮出一句话

点一下挂件（**整块**都算判定区，**没拖动**才算点击，拖动由同一套 pointer 状态机区分）：

- 随机播一条语音；
- 整块上方浮出那句台词 **「博士，不准忘记我。」**，停留 3.2 秒后淡出（`LINE_TEXT` / `LINE_MS`）。

刷新按钮与明细面板（含里面的链接）被 `onPointerDown` 里的
`closest('.pw-refresh, .pw-panel, a')` 排除在外，它们自己处理点击。

语音数据**内联在 `client.js` 顶部**，由同目录的脚本注入：

```bash
python inject_voice.py "C:\path\a.wav" "C:\path\b.wav"   # 可传多个，点击时随机挑
```

- **为什么内联而不是走宿主路由**：宿主半（`index.js`）的代码改了要重启 DSH 进程才生效；
  内联进客户端只需刷新页面。
- **代价**：音频跟着页面走（206 KB 的 wav → 约 275 KB 的 base64）。语音一多就该改成
  "宿主扫目录 + 在 state 里给列表"。
- 重复运行脚本是**幂等**的：数据块由 `__VOICE_DATA_BEGIN__/END` 两个标记框住，旧的整块
  会被替换。**不要手改那一行**。
- 音量在 `client.js` 的 `VOICE_VOLUME`（默认 0.9）。

## 三种改动的生效路径（重要）

| 改什么 | 怎么生效 | 为什么 |
|---|---|---|
| **配置值**（`cordis.patch.yml` 里的 `scale` / `corner`） | toggle 一次 bundle | 配置在装载时读入 |
| **宿主半代码**（`index.js`） | **必须重启 DSH 进程** | 宿主按模块路径缓存，toggle 不重新 import |
| **客户端半代码**（`client.js`：灰影 / 台词 / 语音 / 布局） | **刷新页面** | HMR 接收器虽然活着，但 bundle 要重新构建，而那需要 `pnpm run dev:web` 这个 watcher；本机（Desktop 安装）没有在跑 |

**绕开宿主模块缓存的一个实用办法**：**改包名**（连同目录名、`cordis.patch.yml` 的
`id`/`name`、客户端模块 id 与路由前缀一起改）。模块路径一变，宿主就会重新 import，
不必重启进程。本项目从 `dsh-priestess-widget` 改名为 `dsh-priestess-companion` 时，
`index.js` 里那些改动（图片地址带内容哈希、缓存头改 `no-cache`）就是靠这一下才真正生效的。

## 安装

插件是本地目录，用 `dsh plugin`（它把参数透传给 pnpm）：

```bash
# 语法：dsh plugin --profile <profile> add <包>
dsh plugin --profile desktop add "C:\Users\ASUS\Documents\deepseek-harness\default-workspace\dsh-priestess-companion"
```

注意两点：

- **profile 名要写你自己的**。本机在用的叫 `desktop`（不是帮助里举例的 `tui` / `web`）。
  不确定就用 `dsh --profile desktop --dump-config | findstr priestess` 看它进没进配置树。
- **只做 `pnpm add` 不够**：还得让这个包出现在 profile 的
  `dsh.profile.bundles` 列表里，否则依赖装了、插件不激活。用插件管理器安装会自动做掉
  这一步（本机就是通过 `plugin_manager` 安装的，安装结果 `application: applied`）。

装完**刷新页面**即可，无需重启 DSH。

## 使用

| 操作 | 结果 |
|---|---|
| 按住她拖动 | 挂件跟随鼠标；松开即停 |
| 松开后刷新页面 | 她还在你放下的地方（位置存在浏览器 localStorage，键 `dsh-priestess-companion:position`） |
| 点余额旁的 `↻` | 穿透宿主缓存，立刻重新取一次余额 |
| 鼠标停在余额上 | 展开明细：来源、赠送余额、取数时刻、失败原因 |

想让她回到初始角落，在浏览器控制台执行：

```js
localStorage.removeItem('dsh-priestess-companion:position'); location.reload()
```

## 配置项

写进 profile 的 `cordis.patch.yml`（或本插件的 `cordis.patch.yml`）。写坏的字段只会回落成默认值，
不会让插件起不来——这个包刻意不导出 `Config` schema。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后页面那半不渲染任何东西 |
| `source` | `account` | `account` / `url` / `fixed` |
| `url` | `''` | `source: url` 时的接口地址 |
| `fixedValue` / `fixedSymbol` | `88.88` / `¥` | `source: fixed` 时用 |
| `corner` | `bottom-right` | 初始贴角；拖动过之后以记住的位置为准 |
| `offsetX` / `offsetY` | `22` / `18` | 初始位置距边缘的距离（px） |
| `scale` | `250` | 人物图显示宽度（px），高度按比例（本素材 460×518 → 约 281px 高） |
| `image` | `assets/priestess.png` | 相对路径 / 绝对路径 / http(s) 地址 |
| `showDetails` | `true` | 悬停时是否展开明细 |
| `refreshSeconds` | `120` | 自动刷新间隔（秒）；`0` = 只取一次 |
| `cacheSeconds` | `20` | 宿主侧缓存秒数；`0` = 每次都问远端 |

## 排障

宿主每服务一次余额都会写一行日志：

```
dsh-priestess-companion: ready (source=account, image=…\assets\priestess.png)
dsh-priestess-companion: state served -> ¥43.69
dsh-priestess-companion: state served -> signed-out
dsh-priestess-companion: state served -> error=account-service-missing
```

- **一行都没有** → 页面那半没跑起来（插件没装 / 没进 bundles / 被禁用），不是余额的问题。
- **有 `ready` 没有 `state served`** → 路由开了但页面没请求：客户端模块没加载。
- **余额旁显示"未登录"** → 账号没登录，或 `source` 填的不是 `account`。
- **图是空的** → 看日志里 `image=` 后面的路径对不对；`MISSING` 就是文件不在那儿。

直接敲路由也能自查（不需要鉴权）：

```powershell
Invoke-WebRequest "http://127.0.0.1:19387/dsh-priestess-companion/state.json?refresh=1" -UseBasicParsing | Select -Expand Content
Invoke-WebRequest "http://127.0.0.1:19387/dsh-priestess-companion/image" -UseBasicParsing -OutFile "$env:TEMP\p.png"
```
