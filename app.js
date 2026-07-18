(function () {
  'use strict';

  // ============ 配置 ============
  const CODE_BASE = 0x10000;     // 代码段
  const CODE_SIZE = 0x10000;     //   64KB
  const STACK_TOP = 0x80000;     // 栈顶（SP 初值）
  const STACK_SIZE = 0x10000;    //   栈区 0x70000 ~ 0x80000
  const DATA_BASE = 0x100000;    // 数据/堆
  const DATA_SIZE = 0x10000;     //   64KB
  const MAX_STEPS = 5000000;     // 运行指令上限（防死循环卡死）

  // ============ DOM ============
  const $ = (id) => document.getElementById(id);
  const editor = $('editor');
  const gutter = $('gutter');
  const exampleSelect = $('exampleSelect');
  const btnLoad = $('btnLoad');
  const btnRun = $('btnRun');
  const btnStep = $('btnStep');
  const btnReset = $('btnReset');
  const btnMemView = $('btnMemView');
  const btnClearOut = $('btnClearOut');
  const memAddr = $('memAddr');
  const memView = $('memView');
  const disasmView = $('disasmView');
  const consoleView = $('consoleView');
  const regsGrid = $('regsGrid');
  const statusDot = $('statusDot');
  const statusText = $('statusText');
  const pcHint = $('pcHint');
  const disasmHint = $('disasmHint');

  // ============ 全局状态 ============
  let ksMod, csMod, ucMod;       // 三个库模块
  let assembler, disassembler;   // Keystone / Capstone 实例
  let emu = null;                // 当前模拟器会话

  // ============ 示例 ============
  const EXAMPLES = [
    {
      name: '1. 两数相加（基础算术）',
      code: `// 把 15 和 27 相加，结果存入 X2
    mov  x0, #15
    mov  x1, #27
    add  x2, x0, x1      // X2 = 42
    // 运行结束后查看 X2`
    },
    {
      name: '2. 循环求和 1+2+...+100',
      code: `// 用循环计算 1 到 100 的和，结果在 X0
    mov  x0, #0          // sum = 0
    mov  x1, #1          // i = 1
loop:
    cmp  x1, #100
    b.gt done            // i > 100 则结束
    add  x0, x0, x1      // sum += i
    add  x1, x1, #1      // i++
    b    loop
done:
    // X0 应为 5050`
    },
    {
      name: '3. 函数调用 blr / ret',
      code: `// 调用 square 函数计算 7 的平方
    mov  x0, #7
    bl   square          // 调用，返回地址存入 LR(X30)
    b    end             // 跳过函数体
square:
    mul  x0, x0, x0      // X0 = X0 * X0
    ret                  // 返回调用者
end:
    // X0 应为 49`
    },
    {
      name: '4. Hello 输出（write 系统调用）',
      code: `// 用 write(1, buf, 3) 输出 "Hi\\n"
// 用 movz/movk 把字符串 "Hi\\n" 装入寄存器再压栈
    movz x0, #0x6948          // 低16位: 'H'=0x48, 'i'=0x69
    movk x0, #0x000a, lsl #16 // 次低16位: '\\n'=0x0a
    str  x0, [sp, #-16]!      // 压入栈（预留缓冲）
    mov  x1, sp              // buf = 栈顶
    mov  x2, #3              // count = 3
    mov  x0, #1              // fd = stdout
    mov  x8, #64             // syscall = write
    svc  #0
    mov  x0, #0              // 退出码 0
    mov  x8, #93             // syscall = exit
    svc  #0`
    },
    {
      name: '5. 内存读写 str / ldr',
      code: `// 把数据写入数据区，再读回相加
    mov  x0, #0x100000        // 数据区地址
    mov  x1, #100
    str  x1, [x0]            // [0x100000] = 100
    mov  x1, #23
    str  x1, [x0, #8]        // [0x100008] = 23
    ldr  x2, [x0]            // x2 = 100
    ldr  x3, [x0, #8]        // x3 = 23
    add  x4, x2, x3          // x4 = 123
    // 查看内存 0x100000 可见写入的数据`
    },
  ];

  // ============ 工具函数 ============
  function setStatus(state, text) {
    statusDot.className = 'dot ' + state;
    statusText.textContent = text;
  }
  function out(text, cls) {
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text;
    consoleView.appendChild(span);
    consoleView.scrollTop = consoleView.scrollHeight;
  }
  function outln(text, cls) { out((text == null ? '' : text) + '\n', cls); }
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function fmtHex(v) {
    let n = typeof v === 'bigint' ? v : BigInt(v);
    return '0x' + n.toString(16).toUpperCase();
  }
  function fmtHexFull(v) {
    let n = typeof v === 'bigint' ? v : BigInt(v);
    return '0x' + n.toString(16).toUpperCase().padStart(16, '0');
  }
  function parseAddr(s) {
    s = String(s).trim();
    if (!s) return null;
    if (/^0x/i.test(s)) return parseInt(s, 16);
    if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
    return parseInt(s, 16); // 兜底按 hex
  }
  function regId(name) { return ucMod['ARM64_REG_' + name]; }
  function readReg(name) {
    let v = emu.uc.reg_read_i64(regId(name));
    return typeof v === 'bigint' ? v : BigInt(v);
  }
  function switchTab(panelClass) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === panelClass));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.classList.contains(panelClass)));
    // 切回面板时刷新其内容（隐藏期间 scrollIntoView/行号同步会失效）
    if (panelClass === 'editor-panel') { updateGutter(); gutter.scrollTop = editor.scrollTop; }
    else if (panelClass === 'disasm-panel' && emu) { renderDisasm(curPC()); }
  }

  // ============ 引擎初始化 ============
  async function initEngines() {
    setStatus('busy', '加载 WASM 引擎…');
    try {
      ksMod = await MKeystone({ locateFile: (p) => 'libs/' + p });
      assembler = new ksMod.Keystone(ksMod.ARCH_ARM64, ksMod.MODE_LITTLE_ENDIAN);

      csMod = await MCapstone({ locateFile: (p) => 'libs/' + p });
      disassembler = new csMod.Capstone(csMod.ARCH_ARM64, csMod.MODE_ARM);

      ucMod = await MUnicorn();
      setStatus('idle', '就绪');
      outln('引擎加载完成：Keystone + Capstone + Unicorn', 'info');
    } catch (e) {
      setStatus('err', '引擎加载失败');
      outln('引擎加载失败：' + (e && e.message ? e.message : e), 'err');
      outln('请通过本地 HTTP 服务器打开本页面（wasm 无法在 file:// 下加载）。', 'info');
      btnLoad.disabled = true;
    }
  }

  // ============ 汇编 + 反汇编 + 创建模拟器 ============
  function assembleAndLoad() {
    if (!assembler) { setStatus('err', '引擎未就绪'); return; }
    setStatus('busy', '汇编中…');
    outln('———— 汇编加载 ————', 'info');
    const code = editor.value;

    let result;
    try {
      result = assembler.asm(code, CODE_BASE);
    } catch (e) {
      setStatus('err', '汇编异常');
      outln('汇编异常：' + (e && e.message ? e.message : e), 'err');
      return;
    }
    if (result.failed) {
      let err = -1;
      try { err = assembler.errno(); } catch (_) {}
      setStatus('err', '汇编失败');
      outln('汇编失败（errno=' + err + '）：请检查语法。', 'err');
      outln('提示：标签用 name:；条件分支写 b.gt / b.eq 等；注释用 //。', 'info');
      return;
    }
    const mc = result.mc;
    const count = result.count;
    outln('汇编成功：' + count + ' 条指令，' + mc.length + ' 字节', 'info');

    // 反汇编（用于准确显示 地址→指令）
    let insns = [];
    try {
      insns = disassembler.disasm(mc, CODE_BASE);
    } catch (e) {
      outln('反汇编失败：' + (e && e.message ? e.message : e), 'err');
    }
    createEmulator(mc, insns);
    setStatus('ok', '已加载，可运行 / 单步');
    enableRunControls(true);
    refreshUI();
    renderMem(parseAddr(memAddr.value) || CODE_BASE);
    switchTab('disasm-panel'); // 移动端：加载后跳到反汇编查看生成的指令
  }

  function createEmulator(mc, insns) {
    if (emu && emu.uc) { try { emu.uc.close(); } catch (_) {} }
    const uc = new ucMod.Unicorn(ucMod.ARCH_ARM64, ucMod.MODE_ARM);
    uc.mem_map(CODE_BASE, CODE_SIZE, ucMod.PROT_ALL);
    uc.mem_map(STACK_TOP - STACK_SIZE, STACK_SIZE, ucMod.PROT_READ | ucMod.PROT_WRITE);
    uc.mem_map(DATA_BASE, DATA_SIZE, ucMod.PROT_ALL);
    uc.mem_write(CODE_BASE, mc);

    // 初始化寄存器
    uc.reg_write_i64(regId('SP'), STACK_TOP);
    for (let i = 0; i <= 30; i++) uc.reg_write_i64(regId('X' + i), 0);
    uc.reg_write_i64(regId('PC'), CODE_BASE);
    uc.reg_write_i64(regId('NZCV'), 0);

    emu = {
      uc, mc, insns,
      codeBase: CODE_BASE, codeSize: mc.length,
      exited: false, pcHistory: new Set(), regCache: {}
    };
    // 系统调用钩子：拦截 svc #0
    uc.hook_add(ucMod.HOOK_INTR, intrHandler);
  }

  // ============ 系统调用处理（svc #0） ============
  // 约定（类似 Linux aarch64）：x8 = 系统调用号
  //   64 = write(fd, buf, count)：x0=fd x1=buf x2=count
  //   93 = exit(code)：x0=code
  //   1  = printint（自定义便捷）：打印 x0 十进制
  function intrHandler(handle, intno, ud) {
    const num = Number(emu.uc.reg_read_i64(regId('X8')));
    switch (num) {
      case 64: {
        const buf = Number(emu.uc.reg_read_i64(regId('X1')));
        const cnt = Number(emu.uc.reg_read_i64(regId('X2')));
        const bytes = emu.uc.mem_read(buf, cnt);
        out(new TextDecoder().decode(bytes));
        break;
      }
      case 93: {
        const code = Number(emu.uc.reg_read_i64(regId('X0')));
        emu.exited = true;
        out('\n[exit] 程序结束，退出码 ' + code + '\n', 'info');
        try { emu.uc.emu_stop(); } catch (_) {}
        break;
      }
      case 1: {
        const v = Number(emu.uc.reg_read_i64(regId('X0')));
        out(String(v) + '\n');
        break;
      }
      default:
        out('[svc] 未知系统调用号 x8=' + num + '（支持 64=write / 93=exit / 1=printint）\n', 'err');
    }
  }

  // ============ 执行控制 ============
  function curPC() { return Number(emu.uc.reg_read_i64(regId('PC'))); }
  function isFinished() {
    return emu.exited || curPC() >= emu.codeBase + emu.codeSize;
  }

  function runAll() {
    if (!emu) return;
    if (isFinished()) { setStatus('ok', '已结束'); return; }
    setStatus('busy', '运行中…');
    try {
      const pc = curPC();
      emu.uc.emu_start(pc, emu.codeBase + emu.codeSize, 0, MAX_STEPS);
      afterRun();
    } catch (e) {
      handleErr(e);
    }
  }
  function afterRun() {
    refreshUI();
    const pc = curPC();
    if (emu.exited) setStatus('ok', '运行结束（exit）');
    else if (pc >= emu.codeBase + emu.codeSize) setStatus('ok', '运行结束（PC 越界）');
    else setStatus('err', '运行暂停（指令上限或异常）');
    switchTab('regs-panel'); // 移动端：运行后跳到寄存器查看结果变化
  }

  function stepOnce() {
    if (!emu) return;
    if (isFinished()) { setStatus('ok', '已结束'); return; }
    try {
      const pc = curPC();
      emu.uc.emu_start(pc, pc + 4, 0, 1);
      emu.pcHistory.add(pc);
      afterStep();
    } catch (e) {
      handleErr(e);
    }
  }
  function afterStep() {
    refreshUI();
    if (isFinished()) setStatus('ok', '执行结束');
    else setStatus('ok', '已单步');
    switchTab('regs-panel'); // 移动端：单步后跳到寄存器查看变化
  }

  function reset() {
    if (!emu) return;
    createEmulator(emu.mc, emu.insns);
    outln('———— 已重置 ————', 'info');
    setStatus('ok', '已重置');
    refreshUI();
    renderMem(parseAddr(memAddr.value) || CODE_BASE);
    switchTab('disasm-panel');
  }

  function handleErr(e) {
    setStatus('err', '执行错误');
    outln('执行错误：' + (e && e.message ? e.message : e), 'err');
    refreshUI();
  }

  function enableRunControls(on) {
    btnRun.disabled = !on;
    btnStep.disabled = !on;
    btnReset.disabled = !on;
  }

  // ============ 渲染 ============
  function refreshUI() {
    renderRegs();
    renderDisasm(curPC());
  }

  function regCell(name, v, changed, special) {
    return '<div class="reg' + (changed ? ' changed' : '') + (special ? ' special' : '') + '">' +
      '<span class="rn">' + name + '</span><span class="rv">' + fmtHex(v) + '</span></div>';
  }

  function renderRegs() {
    if (!emu) { regsGrid.innerHTML = ''; pcHint.textContent = 'PC: —'; return; }
    const cells = [];
    for (let i = 0; i <= 30; i++) {
      const name = 'X' + i;
      const v = readReg(name);
      const prev = emu.regCache[name];
      const changed = prev !== undefined && prev !== v;
      emu.regCache[name] = v;
      cells.push(regCell(name, v, changed, false));
    }
    const sp = readReg('SP');
    cells.push(regCell('SP', sp, emu.regCache['SP'] !== undefined && emu.regCache['SP'] !== sp, true));
    emu.regCache['SP'] = sp;
    regsGrid.innerHTML = cells.join('');

    const pc = readReg('PC');
    pcHint.textContent = 'PC: ' + fmtHexFull(pc);

    // NZCV
    const nzcv = Number(emu.uc.reg_read_i64(regId('NZCV')));
    $('flagN').classList.toggle('on', !!(nzcv & 8));
    $('flagZ').classList.toggle('on', !!(nzcv & 4));
    $('flagC').classList.toggle('on', !!(nzcv & 2));
    $('flagV').classList.toggle('on', !!(nzcv & 1));
  }

  function renderDisasm(curAddr) {
    if (!emu || !emu.insns.length) { disasmView.textContent = '汇编加载后显示指令列表'; disasmHint.textContent = '—'; return; }
    const lines = [];
    let curIdx = -1;
    for (let i = 0; i < emu.insns.length; i++) {
      const ins = emu.insns[i];
      const a = Number(ins.address);
      const cur = a === curAddr;
      if (cur) curIdx = i;
      const off = a - emu.codeBase;
      let bstr = '';
      for (let k = 0; k < ins.size; k++) bstr += emu.mc[off + k].toString(16).padStart(2, '0') + ' ';
      const done = emu.pcHistory.has(a);
      const text = (ins.mnemonic + ' ' + (ins.op_str || '')).trim();
      lines.push(
        '<div class="disasm-line' + (cur ? ' cur' : '') + (done ? ' done' : '') + '">' +
        '<span class="da">0x' + a.toString(16).padStart(8, '0') + '</span>' +
        '<span class="dbytes">' + bstr.trim() + '</span>' +
        '<span class="dsrc">' + escapeHtml(text) + '</span></div>'
      );
    }
    disasmView.innerHTML = lines.join('');
    disasmHint.textContent = emu.insns.length + ' 条指令';
    if (curIdx >= 0) {
      const el = disasmView.children[curIdx];
      if (el) el.scrollIntoView({ block: 'center' });
    }
  }

  function renderMem(addr) {
    if (!emu) { memView.textContent = '请先汇编加载'; return; }
    const size = 128;
    try {
      const bytes = emu.uc.mem_read(addr, size);
      const lines = [];
      for (let r = 0; r < size; r += 16) {
        const rowAddr = addr + r;
        let hex = '', ascii = '';
        for (let c = 0; c < 16; c++) {
          const b = bytes[r + c];
          hex += b.toString(16).padStart(2, '0') + ' ';
          ascii += (b >= 32 && b < 127) ? String.fromCharCode(b) : '·';
        }
        lines.push('<span class="da">0x' + rowAddr.toString(16).padStart(8, '0') + '</span>  ' + hex + ' ' + ascii);
      }
      memView.innerHTML = lines.join('\n');
    } catch (e) {
      memView.textContent = '读取失败：' + (e && e.message ? e.message : e) + '（地址未映射？）';
    }
  }

  // ============ 行号 ============
  function updateGutter() {
    const n = editor.value.split('\n').length;
    let s = '';
    for (let i = 1; i <= n; i++) s += i + '\n';
    gutter.textContent = s;
    gutter.scrollTop = editor.scrollTop;
  }

  // ============ 示例 ============
  function populateExamples() {
    exampleSelect.innerHTML = '';
    EXAMPLES.forEach((ex, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = ex.name;
      exampleSelect.appendChild(opt);
    });
    loadExample(0);
  }
  function loadExample(i) {
    editor.value = EXAMPLES[i].code;
    updateGutter();
  }

  // ============ 事件绑定 ============
  function bindEvents() {
    btnLoad.addEventListener('click', assembleAndLoad);
    btnRun.addEventListener('click', runAll);
    btnStep.addEventListener('click', stepOnce);
    btnReset.addEventListener('click', reset);
    btnMemView.addEventListener('click', () => {
      const a = parseAddr(memAddr.value);
      if (a != null) renderMem(a);
    });
    memAddr.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnMemView.click(); });
    btnClearOut.addEventListener('click', () => { consoleView.textContent = ''; });
    exampleSelect.addEventListener('change', () => loadExample(Number(exampleSelect.value)));
    editor.addEventListener('input', updateGutter);
    editor.addEventListener('scroll', () => { gutter.scrollTop = editor.scrollTop; });
    // Tab 缩进
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = editor.selectionStart, en = editor.selectionEnd;
        editor.value = editor.value.slice(0, s) + '    ' + editor.value.slice(en);
        editor.selectionStart = editor.selectionEnd = s + 4;
        updateGutter();
      }
    });
    // 移动端底部 Tab 切换
    document.querySelectorAll('.tab').forEach(t => {
      t.addEventListener('click', () => switchTab(t.dataset.tab));
    });
  }

  // ============ 启动 ============
  function init() {
    populateExamples();
    bindEvents();
    initEngines();
  }
  init();
})();
