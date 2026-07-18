# ARM64 汇编运行环境

一个纯前端（HTML/CSS/JS + WebAssembly）的 ARM64 (AArch64) 汇编学习与调试环境。
可直接在浏览器中**编写、汇编、单步执行、查看寄存器/内存**ARM64 汇编代码。

## 技术栈

| 组件 | 库 | 作用 |
|------|----|----|
| 汇编器 | [Keystone.js](https://github.com/AlexAltea/keystone.js) (WASM) | 把汇编源码编译成 ARM64 机器码 |
| 反汇编器 | [Capstone.js](https://github.com/AlexAltea/capstone.js) (WASM) | 把机器码反汇编，用于调试视图精确映射 |
| 模拟器 | [Unicorn.js](https://github.com/AlexAltea/unicorn.js) (WASM, aarch64 单架构) | 执行 ARM64 机器码 |

## 使用方式

### 方式一：直接在线访问（推荐）

已部署到 GitHub Pages，无需安装任何环境，点开即用：

> **https://qiannianhuanxiang.github.io/bbb1/**

首次打开会下载并初始化 WASM 引擎（约 9MB，稍慢属正常），状态栏显示"就绪"后即可使用；之后浏览器会缓存，二次访问很快。手机、电脑均可直接访问。

### 方式二：本地运行（仅开发/调试源码时需要）

如果要从源码本地修改运行，启动一个本地 HTTP 服务器（加载 `.wasm` 需 HTTP 协议，不能用 `file://` 双击打开）：

```bash
python3 -m http.server 8000
```

然后访问 <http://localhost:8000/> 。

## 目录结构

```
.
├── index.html              # 主页面
├── app.js                  # 应用逻辑（汇编/反汇编/执行/UI）
├── style.css               # 样式
├── README.md
└── libs/
    ├── keystone.js         # 汇编器 JS 入口
    ├── keystone.wasm       # 汇编器 WASM（约 4.2MB）
    ├── capstone.js         # 反汇编器 JS 入口
    ├── capstone.wasm       # 反汇编器 WASM（约 3.2MB）
    └── unicorn_aarch64.js  # 模拟器（单文件，WASM 已内嵌，约 1.5MB）
```

## 使用说明

1. 在左侧编辑器编写 ARM64 汇编（顶部下拉有示例）。
2. 点击 **汇编加载**：编译源码 → 反汇编 → 初始化模拟器。
3. 点击 **运行**（执行到底）/ **单步**（每次一条）/ **重置**（恢复初始状态）。
4. 右侧实时显示寄存器（变化的会高亮）、NZCV 标志位、PC。
5. 内存查看：输入地址（如 `0x100000`）点查看，显示 hex dump。
6. 底部反汇编视图高亮当前 PC 指向的指令。

### 内存布局

| 区域 | 地址范围 | 权限 |
|------|----------|------|
| 代码段 | `0x00010000` ~ `0x0001FFFF` | 全 |
| 栈 | `0x00070000` ~ `0x0007FFFF` | 读写（SP 初值 `0x80000`） |
| 数据/堆 | `0x00100000` ~ `0x0010FFFF` | 全 |

### 系统调用约定（svc #0）

模拟一个类似 Linux aarch64 的最小 syscall 子集，用 `x8` 指定调用号：

| x8 | 调用 | 参数 | 说明 |
|----|------|------|------|
| 64 | write | x0=fd, x1=buf, x2=count | 输出 buf 处 count 字节到控制台 |
| 93 | exit  | x0=code | 结束程序 |
| 1  | printint | x0=值 | （自定义便捷调用）打印 x0 的十进制值 |

输出字符串示例（写 `Hi\n` 到栈再用 write）见示例 4。

## 语法约定

- 注释：`//` 行注释。
- 标签：`name:`，可独占一行或置于指令前（`loop: add x0,x0,#1`）。
- 条件分支：`b.gt`、`b.eq`、`b.ne`、`b.lt`、`b.ge`、`b.le` 等带点写法。
- 立即数前缀 `#`，如 `mov x0, #15`。
- 函数调用 `bl label` / 返回 `ret`。

> 提示：Keystone 对超大立即数的 `mov` 会自动展开为 `movz`/`movk` 序列，
> 反汇编视图会如实显示这些展开后的指令。

## 注意事项

- 运行有指令数上限（默认 5,000,000 条）以防死循环卡死浏览器；死循环会在到达上限后暂停。
- 访问未映射内存、非法指令会触发执行错误并在控制台提示。
- 程序执行到代码段末尾（PC 越界）会自动停止。
