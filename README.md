# CodeX · 安卓原生代码查看器

一个能**直接装在安卓手机上、像本地 App 一样访问手机文件**的代码查看器。

- 添加项目：用系统文件选择器选手机任意文件夹，**可浏览、可读取、可写回**
- 语法高亮：关键字 / 函数名 / 变量·类型 / 字符串 / 注释 / 数字分色显示
- 编辑 + 保存：改动可写回原文件
- 搜索：项目全文检索（文件名 + 行号 + 片段，点击跳转）；编辑器内 Ctrl+F 查找
- 文件关联：微信里收到 `.py / .js / .ts / .java / .c / .cpp / .json / .txt` 等代码文件，可「用 CodeX 打开」

> 与之前 PWA/TWA 版本的本质区别：本版本是**原生安卓 App**（Kotlin WebView + Storage Access Framework），
> 不依赖浏览器、不受「网页无法访问手机文件系统」限制，装到手机就是独立进程。

---

## 一、本机零安装出包（GitHub Actions 在线编译）

你不需要装 Android Studio、Java、Gradle。把工程推到 GitHub，Actions 自动编译出 APK。

### 1. 创建 GitHub 仓库
在 GitHub 新建一个**公开或私有**仓库（如 `codex-android`）。

### 2. 推送本工程到仓库根目录
```bash
cd codex-android
git init
git add -A
git commit -m "CodeX 安卓代码查看器"
git branch -M main
git remote add origin https://github.com/<你的用户名>/codex-android.git
git push -u origin main
```

### 3. 触发编译
- 推送后自动触发；也可在仓库 **Actions → Build CodeX APK → Run workflow** 手动触发。

### 4. 下载 APK
- 进入 **Actions → 最近一次运行 → 右侧 Artifacts → `codex-app-release`** 下载压缩包。
- 解压得到 `app-release-unsigned.apk`（自签名、未对齐，手机可直接安装测试）。

---

## 二、手机安装与授权

1. 把 `app-release-unsigned.apk` 传到手机（微信 / QQ / USB / 邮件都行）。
2. 点击安装 → 若提示「未知来源应用」，去设置允许「此来源」安装。
3. 首次打开点「＋ 项目」→ 系统会弹出文件夹选择器 → 选一个手机目录。
   - 首次会请求「允许访问该文件夹」，**务必点「允许 / 永久允许」**，否则读不到文件。
4. 之后该目录会保留在「我的项目」，下次直接打开。

> 自签名包安装时可能提示「签名风险 / 未上架」，属于正常，点继续即可。

---

## 三、微信文件关联

1. 微信里收到代码文件（如 `.py`）→ 点开 → 右上角「···」或「用其他应用打开」。
2. 在应用列表里选 **CodeX**（若没有，点「更多 / 在所有应用中查找」）。
3. CodeX 会直接打开该文件并高亮显示。

> 说明：从微信打开的单文件，受 Android 权限限制通常**只读**（无法写回微信缓存区），
> 这是系统沙箱机制，非 App 缺陷；用「＋ 项目」选过的文件夹则可正常读写。

---

## 四、想改图标 / 应用名 / 包名

- 应用名：`app/src/main/res/values/strings.xml` 的 `app_name`
- 包名：`app/build.gradle` 的 `applicationId`（改后需同步改 `namespace`）
- 图标：`app/src/main/res/drawable/ic_launcher.xml`（矢量，可换成自己的 SVG path）

---

## 五、本机 Android Studio 编译（可选）

若你本机有 Android Studio：用 AS 打开本工程目录 → 等 Gradle Sync 完成 →
菜单 **Build → Build Bundle(s) / APK(s) → Build APK(s)** → 产物在 `app/build/outputs/apk/release/`。

---

## 六、常见编译失败排查

| 现象 | 原因 / 解决 |
|---|---|
| `Could not determine... Android SDK` | Actions 里 `setup-android` 未正确授权；确认已含「Accept Android licenses」步骤 |
| `Failed to install... android-34` | 编译时自动下载 SDK 需联网；GitHub Actions 默认可联网，重试即可 |
| `minimum supported Gradle...` | AGP 8.2.2 需 Gradle 8.1+；本工程已锁定 8.2，勿改 `gradle-wrapper.properties` |
| 权限选了但读不到文件 | 系统只授权了你选中的那一层目录；用「＋ 项目」重新选一次并点「永久允许」 |

---

## 七、工程结构

```
codex-android/
├── .github/workflows/build-apk.yml   # 一键在线出包
├── app/
│   ├── build.gradle                  # 应用配置（包名/SDK/依赖）
│   └── src/main/
│       ├── AndroidManifest.xml        # 权限 + 文件关联 intent-filter
│       ├── java/com/codex/app/
│       │   ├── MainActivity.kt        # WebView 承载 + 文件选择器 + 微信关联
│       │   └── FileBridge.kt          # 原生文件桥（SAF 读写手机文件）
│       ├── res/                       # 图标 / 主题 / 名称
│       └── assets/www/                # 复用的 Web 代码（高亮/编辑器/搜索）
│           ├── index.html
│           ├── css/styles.css
│           └── js/{highlight,fs,editor,app}.js
├── build.gradle / settings.gradle    # Gradle 工程配置
└── gradle/wrapper/gradle-wrapper.properties
```
